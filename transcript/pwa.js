if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/transcript/sw.js', {
      scope: '/transcript/',
      updateViaCache: 'none',
    }).catch(error => {
      console.warn('Не удалось подключить офлайн-экран.', error);
    });
  });
}
