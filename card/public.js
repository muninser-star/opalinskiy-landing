import {
  aliasUrl, client, copyText, fieldLink, fieldTypes, isPhone, message,
  node, resolveAssets, setAccent, webUrl
} from './common.js';
import {buildVcard, pictureBase64} from './vcard.js';

const db = client();
const cardRoot = document.querySelector('#card');
const share = document.querySelector('#share-card');
const dialog = document.querySelector('#share-dialog');
const shareStatus = document.querySelector('#share-status');
let currentShare;

function paragraph(text, cls) {
  return text ? node('p', {cls, text}) : null;
}

function buildHero(card, assets) {
  const name = [card.firstName, card.lastName].filter(Boolean).join(' ');
  const photo = assets.get(card.photo);
  const coverImage = assets.get(card.cover);
  const cover = node('div', {cls: coverImage ? 'cover image-cover' : 'cover', 'aria-hidden': true},
    coverImage ? node('img', {src: coverImage, alt: ''}) : null);
  const save = node('a', {cls: 'button primary', id: 'save-vcard', text: 'Сохранить в контакты'});
  const status = node('p', {cls: 'hint', role: 'status', hidden: true});
  let objectUrl;
  const loadContact = async () => {
    try {
      if (card.photo && !photo) throw new Error('Photo unavailable');
      const jpeg = photo ? await pictureBase64(photo) : '';
      const data = buildVcard(card, jpeg);
      objectUrl = URL.createObjectURL(new Blob([data], {type: 'text/vcard;charset=utf-8'}));
      save.href = objectUrl;
      save.download = 'denis-opalinskiy.vcf';
      message(status, '');
    } catch {
      message(status, 'Не удалось загрузить фото для контакта. Нажмите, чтобы попробовать снова.', 'error');
    }
  };
  save.addEventListener('click', async event => {
    if (objectUrl) return;
    event.preventDefault();
    await loadContact();
    if (objectUrl) save.click();
  });
  save.setAttribute('role', 'button');
  save.tabIndex = 0;
  save.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !objectUrl) save.click();
  });
  void loadContact();

  return node('article', {cls: 'hero'}, cover,
    node('div', {cls: photo ? 'hero-content' : 'hero-content no-photo'},
      photo ? node('img', {src: photo, cls: 'portrait', alt: 'Фото профиля', width: 140, height: 140}) : null,
      node('h1', {text: name}), paragraph(card.headline, 'headline'), paragraph(card.role, 'role'), paragraph(card.about, 'about'),
      node('div', {cls: 'actions'}, save), status));
}

function buildContacts(fields, assets) {
  const rows = fields.map(field => {
    const file = field.type === 'file';
    const href = file ? assets.get(field.value) : fieldLink(field.type, field.value);
    if (!href) return null;
    const title = field.label || fieldTypes[field.type]?.[0] || 'Ссылка';
    const detail = isPhone(field.type) || field.type === 'email' ? field.value : '';
    const external = href.startsWith('https:') && !file;
    return node('li', {}, node('a', {href, cls: 'contact-row', target: external ? '_blank' : null, rel: external ? 'noopener noreferrer' : null,
      download: file ? field.filename || 'attachment' : null},
      node('span', {}, node('strong', {text: title}), detail ? node('small', {text: detail}) : null),
      node('span', {cls: 'contact-arrow', 'aria-hidden': true})));
  }).filter(Boolean);
  return rows.length ? node('section', {cls: 'panel'},
    node('h2', {text: 'Контакты'}), node('ul', {cls: 'contact-list'}, ...rows)) : null;
}

function labeledField(label, name, attrs = {}, type = 'input') {
  return node('label', {text: label}, node(type, {name, ...attrs}));
}

function buildInquiry(config) {
  if (!config?.enabled || !config.consentText || !webUrl(config.consentUrl)) return null;
  const form = node('form');
  const submit = node('button', {cls: 'button primary', type: 'submit', text: 'Отправить'});
  const status = node('p', {cls: 'hint', role: 'status', hidden: true});
  const phone = labeledField('Телефон', 'phone', {type: 'tel', autocomplete: 'tel', maxlength: 30});
  const email = labeledField('Электронная почта', 'email', {type: 'email', autocomplete: 'email', maxlength: 254});
  let id = crypto.randomUUID();

  form.append(
    labeledField('Имя', 'name', {required: true, autocomplete: 'name', maxlength: 120}),
    email, phone,
    node('details', {}, node('summary', {text: 'Ещё поля'}),
      labeledField('Компания', 'company', {autocomplete: 'organization', maxlength: 150}),
      labeledField('Должность', 'job', {autocomplete: 'organization-title', maxlength: 150}),
      labeledField('Комментарий', 'comment', {rows: 3, maxlength: 2000}, 'textarea')),
    node('label', {cls: 'honeypot', 'aria-hidden': true, text: 'Оставьте пустым'},
      node('input', {name: 'website', tabindex: '-1', autocomplete: 'off'})),
    node('label', {cls: 'check'}, node('input', {type: 'checkbox', name: 'consent', required: true}),
      node('span', {text: config.consentText + ' '},
        node('a', {text: 'Условия обработки данных', href: webUrl(config.consentUrl), target: '_blank', rel: 'noopener noreferrer'}))),
    submit, status);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const fields = new FormData(form);
    if (fields.get('website')) return;
    if (!fields.get('email').trim() && !fields.get('phone').trim()) {
      message(status, 'Укажите электронную почту или телефон.', 'error');
      email.querySelector('input').focus();
      return;
    }
    submit.disabled = true;
    message(status, 'Отправляем…');
    try {
      const {error} = await db.rpc('business_card_submit_inquiry', {
        submission_id: id,
        visitor_name: fields.get('name'),
        visitor_email: fields.get('email'),
        visitor_phone: fields.get('phone'),
        visitor_company: fields.get('company'),
        visitor_job: fields.get('job'),
        visitor_message: fields.get('comment'),
        consent: fields.has('consent')
      });
      if (error) throw error;
      form.reset();
      id = crypto.randomUUID();
      message(status, 'Контакты отправлены.');
    } catch (error) {
      const text = {
        rate_limited: 'Слишком много отправок. Попробуйте чуть позже.',
        invalid_inquiry: 'Проверьте имя, адрес почты, телефон и согласие.',
        form_disabled: 'Приём контактов временно закрыт.'
      }[error.message] || 'Не удалось отправить. Попробуйте ещё раз.';
      message(status, text, 'error');
    } finally {
      submit.disabled = false;
    }
  });
  return node('section', {cls: 'panel'}, node('h2', {text: 'Оставьте свои контакты для связи'}), form);
}

async function showCard() {
  cardRoot.setAttribute('aria-busy', 'true');
  try {
    const {data, error} = await db.from('business_card_public').select('configuration').maybeSingle();
    if (error) throw error;
    if (!data) {
      cardRoot.replaceChildren(node('p', {cls: 'notice', text: 'Визитка сейчас недоступна.'}));
      return;
    }
    const card = data.configuration;
    const filePaths = card.fields.filter(field => field.type === 'file').map(field => field.value);
    const assets = await resolveAssets(db, [card.photo, card.cover, ...filePaths]);
    setAccent(card.accent);
    const company = card.company || card.companyAbout
      ? node('section', {cls: 'panel'}, node('h2', {text: 'О компании'}),
        paragraph(card.company, 'headline'), paragraph(card.companyAbout, 'about')) : null;
    cardRoot.replaceChildren(...[
      buildHero(card, assets), buildContacts(card.fields, assets), company, buildInquiry(card.inquiry)
    ].filter(Boolean));
    currentShare = {url: aliasUrl(card.slug), title: [card.firstName, card.lastName].filter(Boolean).join(' ')};
    share.hidden = false;
  } catch {
    const retry = node('button', {cls: 'button outline', text: 'Повторить загрузку'});
    retry.addEventListener('click', showCard);
    cardRoot.replaceChildren(node('p', {cls: 'notice', 'data-tone': 'error', text: 'Не удалось загрузить визитку.'}), retry);
  } finally {
    cardRoot.setAttribute('aria-busy', 'false');
  }
}

share.addEventListener('click', () => {
  const anchor = document.querySelector('#share-url');
  anchor.href = currentShare.url;
  anchor.textContent = currentShare.url.replace(/^https:\/\//, '');
  message(shareStatus, '');
  dialog.showModal();
});
document.querySelector('#copy-link').addEventListener('click', async () => {
  try {
    await copyText(currentShare.url);
    message(shareStatus, 'Ссылка скопирована.');
  } catch {
    message(shareStatus, 'Выделите ссылку выше и скопируйте её.');
  }
});
const send = document.querySelector('#send-link');
send.hidden = !navigator.share;
send.addEventListener('click', async () => {
  try {
    await navigator.share(currentShare);
  } catch (error) {
    if (error.name !== 'AbortError') message(shareStatus, 'Скопируйте ссылку, чтобы отправить её.');
  }
});
void showCard();
