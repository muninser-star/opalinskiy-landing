import {
  aliasUrl, client, copyText, fieldLink, fieldTypes, isPhone, message, node,
  resolveAssets, setAccent, webUrl
} from './common.js?v=2';
import {toJpeg} from './vcard.js?v=2';

const db = client(true);
const form = document.querySelector('#editor-form');
const login = document.querySelector('#sign-in');
const status = document.querySelector('#editor-status');
const logout = document.querySelector('#sign-out');
const saveStatus = document.querySelector('#save-status');
const saveButton = document.querySelector('#save-card');
const fieldsRoot = document.querySelector('#fields');
const publication = document.querySelector('#toggle-publication');
const pendingFiles = new Map();
const textKeys = ['firstName', 'lastName', 'headline', 'role', 'about', 'company', 'companyAbout', 'accent', 'slug'];
const imageLabels = {photo: 'Фото', cover: 'Обложка'};
const colorChoices = [
  ['Терракотовый', '#a2441f'], ['Синий', '#284b8e'], ['Зелёный', '#24583f'],
  ['Красный', '#b0342d'], ['Графитовый', '#2b3037']
];
const fileTypes = {
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};
let card, version, published, assets = new Map(), working = false;

function button(text, callback, cls = 'button outline') {
  const result = node('button', {type: 'button', cls, text});
  result.addEventListener('click', callback);
  return result;
}

function label(text, element) {
  return node('label', {text}, element);
}

function renderAlias() {
  const slug = form.elements.slug.value;
  const url = aliasUrl(slug);
  const anchor = node('a', {text: url, href: url, target: '_blank', rel: 'noopener'});
  const copy = button('Скопировать', async () => {
    try {
      await copyText(url);
      message(saveStatus, 'Ссылка скопирована.');
    } catch {
      message(saveStatus, 'Выделите и скопируйте ссылку.');
    }
  });
  document.querySelector('#alias').replaceChildren(node('div', {cls: 'alias-row'}, anchor, copy));
}

function renderImage(key) {
  const container = document.querySelector('#' + key + '-image');
  const staged = pendingFiles.get(key);
  const value = staged?.preview || assets.get(card[key]);
  const input = node('input', {type: 'file', accept: 'image/*', name: key + '-upload'});
  const preview = value ? node('img', {src: value, alt: imageLabels[key]}) : null;
  const remove = staged || card[key] ? button('Убрать', () => {
    clearPending(key);
    card[key] = '';
    renderImage(key);
  }) : null;
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 20 * 1024 * 1024) {
      message(saveStatus, 'Выберите изображение размером до 20 МБ.', 'error');
      return;
    }
    clearPending(key);
    pendingFiles.set(key, {file, preview: URL.createObjectURL(file)});
    renderImage(key);
  });
  container.replaceChildren(label(imageLabels[key], input), ...[preview, remove].filter(Boolean));
}

function clearPending(key) {
  const preview = pendingFiles.get(key)?.preview;
  if (preview) URL.revokeObjectURL(preview);
  pendingFiles.delete(key);
}

function renderFields(focusId = '', focusAction = '') {
  fieldsRoot.replaceChildren();
  if (!card.fields.length) {
    fieldsRoot.append(node('p', {cls: 'hint', text: 'Пока нет полей.'}));
    return;
  }

  let focusTarget;
  card.fields.forEach((field, index) => {
    const [typeLabel, placeholder] = fieldTypes[field.type] || fieldTypes.link;
    const name = node('input', {value: field.label, maxlength: 120, placeholder: typeLabel});
    name.addEventListener('input', () => { field.label = name.value; });
    const controls = [label('Подпись', name)];
    let valueInput;
    if (field.type === 'file') {
      const selected = pendingFiles.get(field.id)?.file.name || field.filename;
      const file = node('input', {type: 'file', accept: Object.keys(fileTypes).map(ext => '.' + ext).join(',')});
      valueInput = file;
      file.addEventListener('change', () => {
        const chosen = file.files[0];
        if (!chosen) return;
        const ext = chosen.name.split('.').pop().toLowerCase();
        if (chosen.size > 10 * 1024 * 1024 || !fileTypes[ext]) {
          message(saveStatus, 'Выберите поддерживаемый файл размером до 10 МБ.', 'error');
          return;
        }
        pendingFiles.set(field.id, {file: chosen});
        renderFields(field.id, 'input');
      });
      const href = assets.get(field.value);
      controls.push(node('div', {}, label('Заменить или выбрать файл', file),
        selected ? (href && !pendingFiles.has(field.id)
          ? node('a', {href, text: selected, target: '_blank', rel: 'noopener'})
          : node('p', {text: selected})) : null));
    } else {
      const value = node('input', {value: field.value, maxlength: 2048, placeholder,
        type: isPhone(field.type) ? 'tel' : field.type === 'email' ? 'email' : 'text'});
      valueInput = value;
      value.addEventListener('input', () => { field.value = value.value; value.setCustomValidity(''); });
      controls.push(label('Значение', value));
    }

    const checkbox = node('input', {type: 'checkbox', checked: field.visible});
    checkbox.addEventListener('change', () => { field.visible = checkbox.checked; });
    const move = (offset, action) => {
      const other = index + offset;
      [card.fields[index], card.fields[other]] = [card.fields[other], card.fields[index]];
      renderFields(field.id, action);
    };
    const up = button('Выше', () => move(-1, 'up'));
    const down = button('Ниже', () => move(1, 'down'));
    up.disabled = index === 0;
    down.disabled = index === card.fields.length - 1;
    if (field.id === focusId) {
      focusTarget = focusAction === 'up' && !up.disabled ? up
        : focusAction === 'down' && !down.disabled ? down : valueInput;
    }
    fieldsRoot.append(node('section', {cls: 'field-row'},
      node('h3', {text: typeLabel}),
      node('div', {cls: 'form-grid'}, ...controls),
      node('div', {cls: 'actions'},
        node('label', {cls: 'check'}, checkbox, node('span', {text: 'Показывать'})),
        up, down, button('Удалить', () => {
          clearPending(field.id);
          card.fields.splice(index, 1);
          renderFields(card.fields[Math.min(index, card.fields.length - 1)]?.id, 'input');
          if (!card.fields.length) document.querySelector('#field-catalog summary').focus();
        }, 'button quiet'))));
  });
  focusTarget?.focus();
}

function renderCatalog() {
  const needle = document.querySelector('#field-search').value.toLowerCase().trim();
  const options = Object.entries(fieldTypes).filter(([type, [title]]) => (type + ' ' + title).toLowerCase().includes(needle));
  const list = document.querySelector('#type-list');
  list.replaceChildren(...options.map(([type, [title]]) => button(title, () => {
    if (card.fields.length >= 50) {
      message(saveStatus, 'Добавлено 50 полей. Удалите ненужное поле, чтобы добавить новое.', 'error');
      return;
    }
    const id = crypto.randomUUID();
    card.fields.push({id, type, label: title, value: '', visible: true});
    renderFields(id, 'input');
  })));
  if (!options.length) list.append(node('p', {cls: 'hint', text: 'Типы не найдены.'}));
}

function renderPublication() {
  document.querySelector('#publication-state').textContent = published ? 'Визитка опубликована.' : 'Визитка снята с публикации.';
  publication.textContent = published ? 'Снять с публикации' : 'Опубликовать';
}

async function refreshAssets() {
  const paths = card.fields.filter(field => field.type === 'file').map(field => field.value);
  assets = await resolveAssets(db, [card.photo, card.cover, ...paths]);
}

async function loadProfile() {
  message(status, 'Загружаем редактор…');
  login.hidden = true;
  logout.hidden = false;
  const {data, error} = await db.from('business_card_profile')
    .select('configuration,published,version').maybeSingle();
  if (error || !data) {
    form.hidden = true;
    message(status, error ? 'Не удалось открыть редактор. Обновите страницу.' : 'У этой учётной записи нет доступа к редактору.', 'error');
    return;
  }
  card = data.configuration;
  version = data.version;
  published = data.published;
  for (const key of textKeys) form.elements[key].value = card[key] || '';
  form.elements.inquiryEnabled.checked = Boolean(card.inquiry?.enabled);
  form.elements.consentText.value = card.inquiry?.consentText || '';
  form.elements.consentUrl.value = card.inquiry?.consentUrl || '';
  await refreshAssets();
  for (const key of Object.keys(imageLabels)) renderImage(key);
  renderFields();
  renderCatalog();
  renderAlias();
  renderPublication();
  setAccent(card.accent);
  message(status, '');
  form.hidden = false;
}

function showLogin() {
  form.hidden = true;
  logout.hidden = true;
  login.hidden = false;
  message(status, '');
}

login.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = login.querySelector('button[type="submit"]');
  submit.disabled = true;
  message(status, 'Входим…');
  const credentials = new FormData(login);
  try {
    const {error} = await db.auth.signInWithPassword({
      email: credentials.get('email').trim(), password: credentials.get('password')
    });
    if (error) {
      message(status, error.status === 400
        ? 'Вход не выполнен. Проверьте почту и пароль своей учётной записи.'
        : 'Сервис входа недоступен. Попробуйте ещё раз.', 'error');
      return;
    }
    login.reset();
    await loadProfile();
  } catch {
    message(status, 'Вход недоступен. Попробуйте ещё раз.', 'error');
  } finally {
    submit.disabled = false;
  }
});

logout.addEventListener('click', async () => {
  const {error} = await db.auth.signOut({scope: 'local'});
  if (error) {
    message(status, 'Не удалось выйти. Попробуйте ещё раз.', 'error');
    return;
  }
  for (const key of pendingFiles.keys()) clearPending(key);
  form.reset();
  fieldsRoot.replaceChildren();
  document.querySelector('#inquiries').replaceChildren();
  card = undefined;
  showLogin();
});

async function upload(key, file, image = false) {
  const ext = image ? 'jpg' : file.name.split('.').pop().toLowerCase();
  const path = crypto.randomUUID() + '.' + ext;
  const content = image ? await toJpeg(file, key === 'photo' ? 512 : 1600) : file;
  const {error} = await db.storage.from('business-card-files').upload(path, content, {
    contentType: image ? 'image/jpeg' : fileTypes[ext], upsert: false
  });
  if (error) throw new Error('Не удалось загрузить файл «' + file.name + '». Попробуйте ещё раз.');
  if (image) {
    card[key] = path;
    const preview = pendingFiles.get(key)?.preview;
    if (preview) assets.set(path, preview);
  } else {
    const field = card.fields.find(item => item.id === key);
    field.value = path;
    field.filename = file.name.slice(0, 180);
  }
  pendingFiles.delete(key);
}

function inputsToCard() {
  for (const key of textKeys) card[key] = form.elements[key].value.trim();
  if (!card.firstName) throw new Error('Укажите имя.');
  card.inquiry = {
    enabled: form.elements.inquiryEnabled.checked,
    consentText: form.elements.consentText.value.trim(),
    consentUrl: webUrl(form.elements.consentUrl.value.trim())
  };
  if (card.inquiry.enabled && !(card.inquiry.consentText && card.inquiry.consentUrl)) {
    throw new Error('Для формы укажите текст согласия и HTTPS-ссылку на условия обработки данных.');
  }
  for (const field of card.fields) {
    if (field.type !== 'file' && field.value.trim() && !fieldLink(field.type, field.value)) {
      throw new Error('Проверьте значение поля «' + (field.label || fieldTypes[field.type][0]) + '».');
    }
  }
}

async function updateProfile(changes) {
  const {data, error} = await db.from('business_card_profile').update(changes)
    .eq('id', true).eq('version', version)
    .select('configuration,published,version').maybeSingle();
  if (error) throw new Error('Не удалось сохранить визитку. Попробуйте ещё раз.');
  if (!data) throw new Error('Визитка обновилась в другом окне или сеанс завершён. Скопируйте несохранённые изменения и откройте редактор заново.');
  version = data.version;
  published = data.published;
  renderPublication();
}

function lock(isWorking) {
  working = isWorking;
  for (const panel of form.querySelectorAll(':scope > .panel')) panel.inert = isWorking;
  saveButton.disabled = isWorking;
  publication.disabled = isWorking;
  logout.disabled = isWorking;
  form.setAttribute('aria-busy', String(isWorking));
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (working) return;
  lock(true);
  message(saveStatus, 'Сохраняем…');
  try {
    inputsToCard();
    for (const [key, {file}] of pendingFiles) await upload(key, file, Object.hasOwn(imageLabels, key));
    await updateProfile({configuration: card});
    const previews = [...assets.values()].filter(url => url.startsWith('blob:'));
    await refreshAssets();
    previews.forEach(URL.revokeObjectURL);
    for (const key of Object.keys(imageLabels)) renderImage(key);
    renderFields();
    message(saveStatus, 'Визитка сохранена.');
  } catch (error) {
    message(saveStatus, error.message, 'error');
  } finally {
    lock(false);
  }
});

publication.addEventListener('click', async () => {
  if (working) return;
  const next = !published;
  const prompt = next
    ? 'Вернуть сохранённую версию визитки на сайт?'
    : 'Снять визитку с публикации? Ранее розданные ссылки снова заработают после публикации.';
  if (!window.confirm(prompt)) return;
  lock(true);
  try {
    await updateProfile({published: next});
    message(saveStatus, next ? 'Визитка опубликована.' : 'Визитка снята с публикации.');
  } catch (error) {
    message(saveStatus, error.message, 'error');
  } finally {
    lock(false);
  }
});

const inquiries = document.querySelector('#inquiries');
async function loadInquiries() {
  message(inquiries, 'Загружаем…');
  const {data, error} = await db.from('business_card_inquiries')
    .select('id,received_at,name,email,phone,company,job,message')
    .order('received_at', {ascending: false});
  if (error || !data.length) {
    message(inquiries, error ? 'Не удалось загрузить заявки. Откройте раздел ещё раз.' : 'Пока заявок нет.', error ? 'error' : '');
    return;
  }
  const dateFormat = new Intl.DateTimeFormat('ru-RU', {dateStyle: 'medium', timeStyle: 'short'});
  inquiries.replaceChildren(...data.map(record => node('article', {cls: 'inquiry-record'},
    node('h3', {text: record.name}),
    node('p', {text: dateFormat.format(new Date(record.received_at))}),
    node('p', {text: [record.email, record.phone, record.company, record.job, record.message].filter(Boolean).join('\n')}),
    button('Удалить заявку', async () => {
      if (!window.confirm('Удалить эту заявку?')) return;
      const {error} = await db.from('business_card_inquiries').delete().eq('id', record.id);
      if (error) message(saveStatus, 'Не удалось удалить заявку.', 'error');
      else await loadInquiries();
    }))));
}

document.querySelector('#inquiry-panel').addEventListener('toggle', event => {
  if (event.target.open && card) void loadInquiries();
});
document.querySelector('#field-search').addEventListener('input', renderCatalog);
form.elements.slug.addEventListener('input', renderAlias);
form.elements.accent.addEventListener('input', () => setAccent(form.elements.accent.value));
document.querySelector('#swatches').replaceChildren(...colorChoices.map(([title, color]) => {
  const swatch = button('', () => {
    form.elements.accent.value = color;
    setAccent(color);
  }, 'swatch');
  swatch.title = title;
  swatch.setAttribute('aria-label', title);
  swatch.style.background = color;
  return swatch;
}));
document.querySelector('#show-qr').addEventListener('click', () => document.querySelector('#editor-qr').showModal());

try {
  const {data} = await db.auth.getSession();
  if (data.session) await loadProfile();
  else showLogin();
} catch {
  showLogin();
  message(status, 'Не удалось проверить сеанс. Войдите снова.', 'error');
}
