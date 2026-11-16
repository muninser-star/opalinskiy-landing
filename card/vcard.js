import {fieldLink, isPhone} from './common.js';

function escapeValue(value = '') {
  return value.replace(/\\/g, '\\\\').replace(/\r\n|\n|\r/g, '\\n').replace(/([;,])/g, '\\$1');
}

function fold(line) {
  const encoder = new TextEncoder();
  let bytes = 0;
  let output = '';
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > 75) {
      output += '\r\n ';
      bytes = 1;
    }
    output += char;
    bytes += size;
  }
  return output;
}

export function buildVcard(card, jpegBase64 = '') {
  const title = card.role || card.headline;
  const lines = [
    'BEGIN:VCARD', 'VERSION:3.0',
    'N:' + escapeValue(card.lastName) + ';' + escapeValue(card.firstName) + ';;;',
    'FN:' + escapeValue([card.firstName, card.lastName].filter(Boolean).join(' '))
  ];
  if (card.company) lines.push('ORG:' + escapeValue(card.company));
  if (title) lines.push('TITLE:' + escapeValue(title));
  for (const {type, value, visible} of card.fields) {
    if (!visible || !fieldLink(type, value)) continue;
    if (isPhone(type)) {
      lines.push('TEL;TYPE=' + (type === 'mobile' ? 'CELL' : 'VOICE') + ':' + fieldLink(type, value).slice(4));
    } else if (type === 'email') {
      lines.push('EMAIL;TYPE=INTERNET:' + escapeValue(value));
    } else if (type === 'link') {
      lines.push('URL:' + escapeValue(fieldLink(type, value)));
    }
  }
  if (jpegBase64) lines.push('PHOTO;ENCODING=b;TYPE=JPEG:' + jpegBase64);
  lines.push('END:VCARD');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export async function pictureBase64(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Photo unavailable');
  const source = await response.blob();
  const photo = source.type === 'image/jpeg' ? source : await toJpeg(source, 512);
  const bytes = new Uint8Array(await photo.arrayBuffer());
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(text);
}

export async function toJpeg(file, maxSide) {
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d', {alpha: false});
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob(
      data => data ? resolve(data) : reject(new Error('Не удалось прочитать изображение.')),
      'image/jpeg', .9));
  } finally {
    image.close();
  }
}
