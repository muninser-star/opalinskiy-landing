export const cardUrl = 'https://www.opalinskiy.ru/card/';
const projectUrl = 'https://cuhplpukqhdfutcymtmv.supabase.co';
const publishableKey = 'sb_publishable_ILfqT6mCyHBOu6BVVRxHKQ_0bPQtNi3';

export function client(editor = false) {
  return window.supabase.createClient(projectUrl, publishableKey, {
    auth: { storageKey: editor ? 'opalinskiy-card-session' : 'opalinskiy-card-public',
      persistSession: editor, autoRefreshToken: editor, detectSessionInUrl: false }
  });
}

export const fieldTypes = {
  mobile: ['Мобильный телефон', '+7 (___) ___-__-__'],
  phone: ['Другой телефон', '+7 (___) ___-__-__'],
  email: ['Электронная почта', 'name@example.com'],
  file: ['Файл', ''],
  link: ['Ссылка', 'https://example.com/'],
  vk: ['VK', '@имя или https://vk.com/…'],
  telegram: ['Telegram', '@имя или https://t.me/…'],
  youtube: ['Канал YouTube', 'https://www.youtube.com/…'],
  whatsapp: ['WhatsApp', 'Номер телефона или https://wa.me/…'],
  max: ['MAX', 'https://max.ru/…'],
  instagram: ['Instagram', 'https://www.instagram.com/…'],
  dzen: ['Дзен', 'https://dzen.ru/…'],
  ok: ['Одноклассники', 'https://ok.ru/…'],
  viber: ['Viber', 'Номер телефона или https://…'],
  linkedin: ['LinkedIn', 'https://www.linkedin.com/…'],
  social: ['Другая соцсеть', 'https://…']
};

export const isPhone = type => type === 'mobile' || type === 'phone';
export const isSocial = type => Object.hasOwn(fieldTypes, type)
  && !['mobile', 'phone', 'email', 'link', 'file'].includes(type);

export function node(tag, {cls, text, ...attrs} = {}, ...children) {
  const element = document.createElement(tag);
  if (cls) element.className = cls;
  if (text != null) element.textContent = text;
  for (const [name, value] of Object.entries(attrs)) {
    if (value != null && value !== false) {
      element.setAttribute(name, value === true ? '' : String(value));
    }
  }
  element.append(...children.filter(child => child != null));
  return element;
}

export function icon(name) {
  if (name === 'max') {
    // Official brand mark from https://go.max.ru/brandbook.
    return node('img', {cls: 'icon', src: new URL('max-icon.png?v=3', import.meta.url).href, alt: '', 'aria-hidden': true});
  }
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const shape = document.createElementNS(ns, 'use');
  shape.setAttribute('href', new URL('icons.svg?v=3#' + name, import.meta.url).href);
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.append(shape);
  return svg;
}

export function message(target, text, tone = '') {
  target.textContent = text;
  target.dataset.tone = tone;
  target.hidden = !text;
}

export function webUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

export function fieldLink(type, input = '', messageUrl = '') {
  const direct = isSocial(type) && webUrl(messageUrl);
  if (direct) return direct;
  const value = input.trim();
  if (!value) return '';
  if (isPhone(type)) {
    if (!/^\+?[0-9 ()-]+$/.test(value) || value.replace(/\D/g, '').length < 5) return '';
    return 'tel:' + value.replace(/[^0-9+]/g, '');
  }
  if (type === 'email') {
    return /^[^\s@?&#,]+@[^\s@?&#,]+\.[^\s@?&#,]+$/.test(value) ? 'mailto:' + value : '';
  }
  if (type === 'telegram' && /^@[a-z0-9_]+$/i.test(value)) {
    return 'https://t.me/' + value.slice(1);
  }
  if (type === 'vk') {
    const handle = /^(?:https:\/\/(?:www\.)?vk\.(?:com|ru)\/|@?)([a-z0-9_.]+)\/?$/i.exec(value);
    if (handle) return 'https://vk.me/' + handle[1];
  }
  if ((type === 'whatsapp' || type === 'viber') && /^\+?[0-9 ()-]+$/.test(value)) {
    const digits = value.replace(/\D/g, '');
    return digits.length >= 7 ? (type === 'whatsapp' ? 'https://wa.me/' : 'viber://chat?number=%2B') + digits : '';
  }
  return webUrl(value);
}

export function isMessageLink(type, href, override) {
  return Boolean(webUrl(override)) || (
    (type === 'telegram' && /^https:\/\/t\.me\/(?:[a-z0-9_]+\/?(?:\?|$)|m\/)/i.test(href))
    || (type === 'vk' && href.startsWith('https://vk.me/'))
    || (type === 'whatsapp' && /^https:\/\/(?:wa\.me\/|api\.whatsapp\.com\/send)/i.test(href))
    || (type === 'viber' && href.startsWith('viber://chat?'))
    || (type === 'linkedin' && /^https:\/\/(?:[a-z]+\.)?linkedin\.com\/messaging\//i.test(href))
  );
}

export function setAccent(color) {
  const hex = /^#[a-f\d]{6}$/i.test(color) ? color : '#a2441f';
  const [r, g, b] = hex.slice(1).match(/.{2}/g).map(chunk => {
    const channel = parseInt(chunk, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  const luminance = .2126 * r + .7152 * g + .0722 * b;
  document.documentElement.style.setProperty('--accent', hex);
  document.documentElement.style.setProperty('--button-ink', luminance > .179 ? '#000' : '#fff');
}

export function aliasUrl(slug) {
  return slug ? cardUrl + '?name=' + encodeURIComponent(slug) : cardUrl;
}

export function storedPath(value) {
  return typeof value === 'string' && /^[0-9a-f-]{36}\.[a-z0-9]{1,8}$/i.test(value);
}

export function inlineAssets(values) {
  return new Map(values.filter(
    value => typeof value === 'string' && /^data:image\/jpeg;base64,[a-z0-9+/]+=*$/i.test(value)
  ).map(value => [value, value]));
}

export async function resolveAssets(db, values) {
  const paths = [...new Set(values.filter(storedPath))];
  const urls = inlineAssets(values);
  if (!paths.length) return urls;
  const {data, error} = await db.storage.from('business-card-files').createSignedUrls(paths, 600);
  if (!error) {
    for (const file of data) if (file.signedUrl) urls.set(file.path, file.signedUrl);
  }
  return urls;
}

export async function copyText(value) {
  await navigator.clipboard.writeText(value);
}
