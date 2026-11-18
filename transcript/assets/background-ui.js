const browserKey = "opalinskiy-transcription-telegram-v1";
const foregroundStates = new Set(["waiting", "pending", "sending", "unavailable"]);
const deliveryMessages = {
  waiting: "Telegram · ожидает отправки",
  pending: "Telegram · ожидает отправки",
  sending: "Telegram · отправляется",
  sent: "Telegram · файл отправлен",
  cancelled: "Telegram · отправка отменена, чат отключён",
  failed: "Telegram · не удалось отправить файл",
  unknown: "Telegram · не удалось подтвердить доставку",
  unavailable: "Telegram · статус пока недоступен",
};

export function browserHeaders(generateSecret) {
  try {
    let secret = localStorage.getItem(browserKey);
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret ?? "")) {
      secret = generateSecret();
      localStorage.setItem(browserKey, secret);
    }
    return { "x-transcription-browser": secret };
  } catch {
    return {};
  }
}

export function restoreSummary(key) {
  return JSON.parse(localStorage.getItem(key) ?? sessionStorage.getItem(key) ?? "null");
}

export function storeSummary(key, job) {
  try {
    if (job) localStorage.setItem(key, JSON.stringify(job));
    else localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  } catch {
    try {
      if (job) sessionStorage.setItem(key, JSON.stringify(job));
      else sessionStorage.removeItem(key);
    } catch {
      // The current page can still show the result when browser storage is unavailable.
    }
  }
}

export function deliveryLabel(state) {
  return Object.hasOwn(deliveryMessages, state) ? deliveryMessages[state] : "";
}

export function watchDelivery(state, request, update) {
  if (!foregroundStates.has(state)) return;
  const controller = new AbortController();
  let timer;
  async function refresh() {
    if (controller.signal.aborted) return;
    try {
      const next = await request(controller.signal);
      if (controller.signal.aborted) return;
      if (next.status === "completed") {
        update(next);
        if (!foregroundStates.has(next.delivery)) return;
      }
    } catch {
      if (controller.signal.aborted) return;
    }
    timer = setTimeout(refresh, 10_000);
  }
  timer = setTimeout(refresh, 5000);
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}

function create(tag, text, className) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

export function installTelegramControls(endpoint, apiKey, generateSecret) {
  async function change(action, code) {
    const headers = browserHeaders(generateSecret);
    if (!headers["x-transcription-browser"]) throw new Error("storage");
    const response = await fetch(endpoint + "?feature=telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: apiKey, ...headers },
      body: JSON.stringify({ action, code }),
      signal: AbortSignal.timeout(15_000),
    });
    const { state } = await response.json();
    if (!response.ok && state !== "invalid_code") throw new Error("telegram");
    return state;
  }

  customElements.define("transcript-telegram", class extends HTMLElement {
    connectedCallback() {
      if (this.childElementCount) return;
      const container = create("details", "", "panel transcript-telegram");
      const heading = create("summary", "Доставка в Telegram");
      const information = create("p", "", "muted");
      information.setAttribute("role", "status");
      const form = create("form", "", "telegram-connect");
      const help = create("p", "Отправьте /transcript семейному боту в личном чате и введите полученный код.", "muted");
      const code = create("input");
      code.type = "text";
      code.maxLength = 32;
      code.autocomplete = "off";
      code.spellcheck = false;
      code.placeholder = "Одноразовый код";
      code.setAttribute("aria-label", "Одноразовый код Telegram");
      code.required = true;
      const connect = create("button", "Подключить", "button primary");
      connect.type = "submit";
      const disconnect = create("button", "Отключить", "button secondary");
      disconnect.type = "button";
      form.append(help, code, connect);
      container.append(heading, information, form, disconnect);
      this.append(container);

      function render(state) {
        const linked = state === "linked";
        heading.textContent = linked ? "Telegram подключён" : "Доставка в Telegram";
        information.textContent = linked
          ? "Готовые расшифровки и саммари из этого браузера будут приходить в личный чат файлами .md."
          : "Подключите личный чат, чтобы получать готовые файлы автоматически.";
        form.hidden = linked;
        disconnect.hidden = !linked;
      }

      const unavailable = () => {
        information.textContent = "Не удалось проверить Telegram. Попробуйте ещё раз.";
      };
      render("unlinked");
      change("status").then(render).catch(unavailable);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        connect.disabled = true;
        try {
          const state = await change("link", code.value);
          if (state === "linked") {
            code.value = "";
            render(state);
          } else {
            information.textContent = "Код недействителен. Запросите новый в личном чате.";
          }
        } catch {
          unavailable();
        } finally {
          connect.disabled = false;
        }
      });
      disconnect.addEventListener("click", async () => {
        disconnect.disabled = true;
        try {
          render(await change("unlink"));
        } catch {
          unavailable();
        } finally {
          disconnect.disabled = false;
        }
      });
    }
  });
}
