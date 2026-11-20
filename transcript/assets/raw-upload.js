const storageOrigin = 'https://cuhplpukqhdfutcymtmv.storage.supabase.co';
const uploadPath = '/storage/v1/upload/resumable/';
const chunkBytes = 6 * 1024 * 1024;
const keyPrefix = 'opalinskiy-transcript-upload-v1:';

function failure() {
  return Object.assign(new Error('Не удалось закончить загрузку. Выберите исходный файл и продолжите.'), {
    code: 'upload_failed',
  });
}

export function checkedUploadUrl(value) {
  const url = new URL(value);
  if (url.origin !== storageOrigin || !url.pathname.startsWith(uploadPath) ||
      url.username || url.password || url.hash) throw failure();
  return url.href;
}

function writeSession(key, session) {
  try {
    if (session) localStorage.setItem(key, JSON.stringify(session));
    else localStorage.removeItem(key);
  } catch {
    // Uploading can continue in this page when browser storage is unavailable.
  }
}

function readSession(key, recording, expectedPath) {
  try {
    const session = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!session || session.path !== expectedPath || session.size !== recording.size ||
        session.name !== recording.name || session.modified !== recording.modified) return null;
    return checkedUploadUrl(session.url);
  } catch {
    writeSession(key, null);
    return null;
  }
}

function offsetFrom(response, size) {
  const value = response.headers.get('upload-offset');
  const offset = value === null ? NaN : Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) throw failure();
  return offset;
}

async function head(url, headers, size) {
  const response = await fetch(checkedUploadUrl(url), {
    method: 'HEAD', headers, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if ([401, 403, 404, 410].includes(response.status)) return null;
  if (!response.ok) throw failure();
  return offsetFrom(response, size);
}

function sendChunk(url, headers, file, offset, progress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PATCH', checkedUploadUrl(url));
    request.timeout = 600_000;
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
    request.setRequestHeader('Upload-Offset', String(offset));
    request.setRequestHeader('Content-Type', 'application/offset+octet-stream');
    request.upload.onprogress = event => {
      if (event.lengthComputable) progress(Math.min(99, Math.floor((offset + event.loaded) * 100 / file.size)));
    };
    request.onerror = request.ontimeout = () => reject(failure());
    request.onload = () => {
      if (request.status === 409) return resolve(null);
      if (request.status !== 204) return reject(failure());
      const value = request.getResponseHeader('upload-offset');
      const next = value === null ? NaN : Number(value);
      if (!Number.isSafeInteger(next) || next <= offset || next > file.size) return reject(failure());
      resolve(next);
    };
    request.send(file.slice(offset, offset + chunkBytes));
  });
}

export async function uploadOriginal(file, recording, request, progress) {
  const config = await request('prepare', recording, { sourceKind: 'raw', name: recording.name });
  const key = keyPrefix + recording.id;
  if (config.status === 'uploaded' || config.accepted) {
    writeSession(key, null);
    progress(100);
    return;
  }
  const expectedPath = 'recordings/' + recording.id + '.' + recording.extension;
  if (config.status !== 'uploading' || config.endpoint !== storageOrigin + uploadPath + 'sign' ||
      config.bucket !== 'transcription-uploads' || config.path !== expectedPath ||
      typeof config.token !== 'string') throw failure();
  const headers = { 'Tus-Resumable': '1.0.0', 'x-signature': config.token };
  let url = readSession(key, recording, expectedPath);
  let offset = url ? await head(url, headers, file.size) : null;
  if (offset === null) {
    const metadata = [
      ['bucketName', config.bucket], ['objectName', config.path],
      ['contentType', config.contentType], ['cacheControl', '0'],
    ].map(([name, value]) => name + ' ' + btoa(value)).join(',');
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { ...headers, 'Upload-Length': String(file.size), 'Upload-Metadata': metadata },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 201) throw failure();
    const location = response.headers.get('location');
    if (!location) throw failure();
    url = checkedUploadUrl(new URL(location, config.endpoint).href);
    offset = response.headers.has('upload-offset')
      ? offsetFrom(response, file.size) : await head(url, headers, file.size);
    if (offset === null) throw failure();
    writeSession(key, {
      url, path: expectedPath, name: recording.name, size: recording.size, modified: recording.modified,
    });
  }
  progress(Math.floor(offset * 100 / file.size));
  let failures = 0;
  while (offset < file.size) {
    const previous = offset;
    try {
      const next = await sendChunk(url, headers, file, offset, progress);
      offset = next === null ? await head(url, headers, file.size) : next;
      if (offset === null) throw failure();
    } catch {
      if (++failures > 3) throw failure();
      const observed = await head(url, headers, file.size);
      if (observed === null) throw failure();
      offset = observed;
    }
    if (offset > previous) failures = 0;
    else if (++failures > 3) throw failure();
    progress(Math.floor(offset * 100 / file.size));
  }
  // Keep the URL until the server confirms that the finished object is visible.
  const finished = await request('prepare', recording, { sourceKind: 'raw', name: recording.name });
  if (finished.status !== 'uploaded' && !finished.accepted) throw failure();
  writeSession(key, null);
  progress(100);
}

export async function recoverOriginal(recording, request) {
  const current = await request('prepare', recording, { sourceKind: 'raw', name: recording.name });
  if (current.status === 'uploaded') {
    const accepted = await request('submit', recording);
    return accepted.accepted === true;
  }
  return current.accepted === true;
}
