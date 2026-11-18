const messages = {
  question_missing: "Доступ к этой записи или саммари истёк. История вопросов очищена.",
  question_source_missing: "Исходный текст недоступен. Загрузите исходник заново, чтобы задавать по нему вопросы.",
  question_limit: "Лимит вопросов временно исчерпан. Попробуйте снова позже.",
  question_edit_conflict: "Саммари уже обновилось. Уточните вопрос, чтобы получить правку к текущей версии.",
  question_edit_limit: "Достигнут лимит правок к этому саммари.",
};

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function installQuestionPanels(endpoint, apiKey) {
  customElements.define("transcript-questions", class extends HTMLElement {
    #config;
    #history = [];
    #request;
    #nodes;
    #expiry;

    connectedCallback() {
      if (this.#nodes) return;
      const details = element("details", "", "transcript-question-panel");
      const summary = element("summary", "Задать вопрос ИИ");
      const messages = element("div", "", "transcript-question-messages");
      messages.setAttribute("role", "log");
      messages.setAttribute("aria-label", "Диалог по записи");
      const status = element("p", "", "muted");
      status.setAttribute("role", "status");
      status.hidden = true;
      const form = element("form", "", "transcript-question-form");
      const input = element("textarea");
      input.rows = 3;
      input.maxLength = 1600;
      input.required = true;
      input.placeholder = "Например, о чём договорились или где в саммари неточность?";
      input.setAttribute("aria-label", "Вопрос или уточнение");
      const button = element("button", "Отправить", "button primary");
      button.type = "submit";
      form.append(input, button);
      details.append(summary, messages, status, form);
      this.append(details);
      this.#nodes = { messages, status, form, input, button };
      details.addEventListener("toggle", () => {
        if (details.open) input.focus();
      });
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void this.#ask();
      });
    }

    disconnectedCallback() {
      this.#request?.abort();
      clearTimeout(this.#expiry);
    }

    configure(config) {
      const previous = this.#config;
      if (previous && (previous.kind !== config.kind || previous.id !== config.id || previous.access !== config.access)) {
        this.#request?.abort();
        this.#reset();
      }
      this.#config = config;
      clearTimeout(this.#expiry);
      if (Number.isFinite(config.expiresAt)) {
        this.#expiry = setTimeout(() => {
          this.#request?.abort();
          this.#reset();
          this.#status(messages.question_missing);
          this.#nodes.form.hidden = true;
        }, Math.max(config.expiresAt - Date.now(), 0));
      } else {
        this.#nodes.form.hidden = false;
      }
    }

    #reset() {
      this.#history = [];
      this.#nodes?.messages.replaceChildren();
    }

    #status(text) {
      this.#nodes.status.textContent = text || "";
      this.#nodes.status.hidden = !text;
    }

    async #post(body, request, config) {
      const response = await fetch(endpoint + "?feature=questions", {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: apiKey, "x-transcription-job": config.access },
        body: JSON.stringify({ kind: config.kind, id: config.id, ...body }),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(105_000)]),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.code || "network");
      return data;
    }

    #log(role, text) {
      const node = element("div", "", "transcript-question-message");
      node.append(element("strong", role), element("p", text));
      this.#nodes.messages.append(node);
      return node;
    }

    #showError(error) {
      if (error.message === "question_missing") this.#reset();
      this.#status(messages[error.message] || "Не удалось получить ответ. Попробуйте ещё раз.");
    }

    async #ask() {
      const config = this.#config;
      const { input, button } = this.#nodes;
      const question = input.value.trim();
      if (!config?.id || !config.access || !question || this.#request) return;
      const request = new AbortController();
      this.#request = request;
      button.disabled = true;
      this.#status("Ищу ответ в записи…");
      try {
        const answer = await this.#post({ action: "ask", question, history: this.#history.slice(-8), names: config.names }, request, config);
        if (request.signal.aborted) return;
        this.#log("Вы", question);
        const entry = this.#log("ИИ", answer.answer);
        for (const citation of answer.citations ?? []) {
          const block = element("blockquote", citation.quote);
          const label = [citation.timecode, citation.speaker].filter(Boolean).join(" · ");
          if (label) block.prepend(element("cite", label));
          entry.append(block);
        }
        if (answer.limited) entry.append(element("p", "Ответ опирается на найденные фрагменты длинной записи.", "muted"));
        if (answer.proposal) this.#showProposal(entry, answer.proposal, config);
        this.#history = [...this.#history, { role: "user", text: question }, { role: "assistant", text: answer.answer }].slice(-8);
        if (input.value.trim() === question) input.value = "";
        this.#status("");
      } catch (error) {
        if (!request.signal.aborted) this.#showError(error);
      } finally {
        if (this.#request === request) {
          this.#request = undefined;
          button.disabled = false;
        }
      }
    }

    #showProposal(entry, proposal, config) {
      const revision = element("div", "", "transcript-question-proposal");
      revision.append(element("strong", proposal.fromUser ? "Ваше уточнение" : "Предлагаемая правка"));
      if (proposal.before) revision.append(element("del", proposal.before));
      revision.append(element("ins", proposal.after));
      const button = element("button", "Применить правку", "button secondary");
      button.type = "button";
      revision.append(button);
      entry.append(revision);
      button.addEventListener("click", async () => {
        if (this.#request || this.#config?.id !== config.id || this.#config?.access !== config.access) return;
        const request = new AbortController();
        this.#request = request;
        button.disabled = true;
        this.#nodes.button.disabled = true;
        this.#status("Применяю правку…");
        try {
          const result = await this.#post({ action: "apply", token: proposal.token }, request, config);
          if (request.signal.aborted) return;
          this.#config.onApplied?.(result);
          button.textContent = "Правка применена";
          this.#status("Саммари обновлено. Правка доступна для скачивания.");
        } catch (error) {
          if (!request.signal.aborted) {
            this.#showError(error);
            button.disabled = false;
          }
        } finally {
          if (this.#request === request) {
            this.#request = undefined;
            this.#nodes.button.disabled = false;
          }
        }
      });
    }
  });
}
