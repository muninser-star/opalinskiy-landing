import {
  aliasUrl, client, copyText, fieldLink, fieldTypes, icon, inlineAssets, isMessageLink,
  isPhone, isSocial, message, node, resolveAssets, setAccent, storedPath, webUrl
} from './common.js?v=3';
import {buildVcard, pictureBase64} from './vcard.js?v=3';

const db = client();
const cardRoot = document.querySelector('#card');
const share = document.querySelector('#share-card');
const dialog = document.querySelector('#share-dialog');
const shareStatus = document.querySelector('#share-status');
let currentShare;

function paragraph(text, cls) {
  return text ? node('p', {cls, text}) : null;
}

async function withinDeadline(run) {
  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Request timed out'));
      }, 6000);
    });
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function assetLoader(values) {
  const assets = inlineAssets(values);
  let pending;
  let loaded = !values.some(storedPath);

  function load(retry = false) {
    if (pending) return pending;
    if (loaded && !retry) return Promise.resolve(assets);
    pending = withinDeadline(() => resolveAssets(db, values))
      .then(result => {
        for (const [value, href] of result) assets.set(value, href);
        loaded = true;
        return assets;
      })
      .finally(() => { pending = undefined; });
    return pending;
  }
  return {assets, load};
}

function buildHero(card, {assets, load}) {
  const name = [card.firstName, card.lastName].filter(Boolean).join(' ');
  const coverImage = node('img', {alt: ''});
  const cover = node('div', {cls: 'cover', 'aria-hidden': true, hidden: true}, coverImage);
  const portrait = node('img', {cls: 'portrait', alt: 'Фото профиля', width: 140, height: 140, hidden: true});
  const save = node('a', {cls: 'button primary', id: 'save-vcard'}, icon('save'), 'Сохранить в контакты');
  const status = node('p', {cls: 'hint', role: 'status', hidden: true});
  let objectUrl;
  let preparation;
  let saving = false;

  async function prepareContact(retry) {
    save.setAttribute('aria-busy', 'true');
    try {
      if (retry && storedPath(card.photo)) await load(true);
      let photo = assets.get(card.photo);
      if (!photo && storedPath(card.photo)) {
        await load();
        photo = assets.get(card.photo);
      }
      if (card.photo && !photo) throw new Error('Photo unavailable');
      showMedia();
      const jpeg = photo ? await withinDeadline(signal => pictureBase64(photo, signal)) : '';
      const data = buildVcard(card, jpeg);
      objectUrl = URL.createObjectURL(new Blob([data], {type: 'text/vcard;charset=utf-8'}));
      save.href = objectUrl;
      save.download = 'denis-opalinskiy.vcf';
      message(status, '');
    } catch {
      message(status, 'Не удалось загрузить фото для контакта. Нажмите, чтобы попробовать снова.', 'error');
    } finally {
      save.setAttribute('aria-busy', 'false');
    }
  }

  function loadContact(retry = false) {
    preparation ??= prepareContact(retry).finally(() => { preparation = undefined; });
    return preparation;
  }

  save.addEventListener('click', async event => {
    if (objectUrl) return;
    event.preventDefault();
    if (saving) return;
    saving = true;
    try {
      await loadContact(true);
      if (objectUrl) save.click();
    } finally {
      saving = false;
    }
  });
  save.setAttribute('role', 'button');
  save.tabIndex = 0;
  save.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !objectUrl) save.click();
  });
  const content = node('div', {cls: 'hero-content'}, portrait,
    node('h1', {text: name}), paragraph(card.headline, 'headline'), paragraph(card.role, 'role'), paragraph(card.about, 'about'),
    node('div', {cls: 'actions'}, save), status);
  const section = node('article', {cls: 'hero'}, cover, content);

  function displayCover(show) {
    cover.hidden = !show;
    section.classList.toggle('has-cover', show);
  }
  coverImage.addEventListener('load', () => displayCover(true));
  coverImage.addEventListener('error', () => displayCover(false));

  function showMedia() {
    const photo = assets.get(card.photo);
    if (photo && portrait.getAttribute('src') !== photo) portrait.src = photo;
    portrait.hidden = !photo;
    const backdrop = assets.get(card.cover);
    if (backdrop && coverImage.getAttribute('src') !== backdrop) {
      displayCover(false);
      coverImage.src = backdrop;
    }
  }

  showMedia();
  return {section, showMedia, loadContact};
}

function buildContacts(fields, assets) {
  const deferred = [];
  const rows = fields.map(field => {
    const file = field.type === 'file';
    const href = file ? assets.get(field.value) : fieldLink(field.type, field.value, field.messageUrl);
    if (!href && !file) return null;
    const title = field.label || fieldTypes[field.type]?.[0] || 'Ссылка';
    const detail = isPhone(field.type) || field.type === 'email' ? field.value
      : isSocial(field.type) && isMessageLink(field.type, href, field.messageUrl) ? 'Написать'
        : field.type === 'linkedin' ? 'Профиль' : '';
    const external = !file && !isSocial(field.type) && href.startsWith('https:');
    const link = node('a', {href, cls: 'contact-row', target: external ? '_blank' : null, rel: external ? 'noopener noreferrer' : null,
      download: file ? field.filename || 'attachment' : null},
      node('span', {cls: 'contact-badge', 'data-service': field.type}, icon(fieldTypes[field.type] ? field.type : 'link')),
      node('span', {}, node('strong', {text: title}), detail ? node('small', {text: detail}) : null),
      node('span', {cls: 'contact-arrow', 'aria-hidden': true}));
    const row = node('li', {hidden: !href}, link);
    if (file) deferred.push({row, link, path: field.value});
    return row;
  }).filter(Boolean);
  const section = node('section', {cls: 'panel', hidden: !rows.some(row => !row.hidden)},
    node('h2', {text: 'Контакты'}), node('ul', {cls: 'contact-list'}, ...rows));
  function showFiles() {
    for (const {row, link, path} of deferred) {
      const href = assets.get(path);
      if (href) link.href = href;
      row.hidden = !href;
    }
    section.hidden = !rows.some(row => !row.hidden);
  }
  return {section, showFiles};
}

function labeledField(label, name, attrs = {}, type = 'input') {
  return node('label', {text: label}, node(type, {name, ...attrs}));
}

function buildInquiry(config) {
  if (!config?.enabled || !config.consentText || !webUrl(config.consentUrl)) return null;
  const form = node('form');
  const submit = node('button', {cls: 'button primary', type: 'submit'}, icon('send'), 'Отправить');
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
  cardRoot.replaceChildren(node('p', {cls: 'notice', role: 'status', text: 'Загружаем визитку…'}));
  share.hidden = true;
  try {
    const {data, error} = await withinDeadline(signal =>
      db.from('business_card_public').select('configuration').abortSignal(signal).maybeSingle());
    if (error) throw error;
    if (!data) {
      cardRoot.replaceChildren(node('p', {cls: 'notice', role: 'status', text: 'Визитка сейчас недоступна.'}));
      return;
    }
    const card = data.configuration;
    const filePaths = card.fields.filter(field => field.type === 'file').map(field => field.value);
    const media = assetLoader([card.photo, card.cover, ...filePaths]);
    const hero = buildHero(card, media);
    const contacts = buildContacts(card.fields, media.assets);
    setAccent(card.accent);
    const company = card.company || card.companyAbout
      ? node('section', {cls: 'panel'}, node('h2', {text: 'О компании'}),
        paragraph(card.company, 'headline'), paragraph(card.companyAbout, 'about')) : null;
    cardRoot.replaceChildren(...[
      hero.section, contacts.section, company, buildInquiry(card.inquiry)
    ].filter(Boolean));
    currentShare = {url: aliasUrl(card.slug), title: [card.firstName, card.lastName].filter(Boolean).join(' ')};
    share.hidden = false;
    void media.load().then(() => {
      hero.showMedia();
      contacts.showFiles();
    }).catch(() => {
      // Metadata and the contact actions are usable when attachments are unavailable.
    });
    void hero.loadContact();
  } catch {
    const retry = node('button', {cls: 'button outline', type: 'button'}, icon('repeat'), 'Повторить загрузку');
    retry.addEventListener('click', showCard);
    cardRoot.replaceChildren(node('p', {cls: 'notice', role: 'alert', 'data-tone': 'error', text: 'Не удалось загрузить визитку.'}), retry);
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
