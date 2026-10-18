window.__ModuleLoader__.load({
  id: "dsh-agent-message",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    const name = "dsh-agent-message-client";
    const inject = ["slots", "timer", "sessions", "uiWorkspace", "locale"];

    function apply(ctx) {
      const senderSelector = "[data-context-relay-sender]";
      const sessionLinks = new Set();
      const subscribeLocale = function (listener) { return ctx.locale.subscribe(listener); };
      const getLocaleSnapshot = function () { return ctx.locale.getSnapshot(); };

      function useLocale() {
        React.useSyncExternalStore(subscribeLocale, getLocaleSnapshot);
      }

      function uiText(zh, en) {
        return getLocaleSnapshot().active === "zh" ? zh : en;
      }

      function sessionRow(id) {
        return ctx.sessions.list.getSnapshot().byId[id];
      }

      function sessionTitle(row) {
        return String(row?.displayTitle || row?.title || row?.id || "");
      }

      function cleanupRoots(node) {
        if (!(node instanceof Element)) return;
        const links = node.matches(".agent-msg-session-link")
          ? [node].concat(Array.from(node.querySelectorAll(".agent-msg-session-link")))
          : Array.from(node.querySelectorAll(".agent-msg-session-link"));
        links.forEach(function (element) { sessionLinks.delete(element); });
      }

      function restoreSender(element) {
        if (element.dataset.agentMsgOriginalText !== undefined) {
          element.textContent = element.dataset.agentMsgOriginalText;
        }
        delete element.dataset.agentMsgOriginalText;
        delete element.dataset.agentMsgSessionId;
        delete element.dataset.agentMsgSenderTitle;
        element.classList.remove("agent-msg-session-link", "agent-msg-sender-link");
        ["role", "tabindex", "title", "aria-label"].forEach(function (name) { element.removeAttribute(name); });
      }

      function senderLink(target) {
        if (!(target instanceof Element)) return null;
        const element = target.closest(senderSelector);
        if (!element) return null;
        if (element.dataset.agentMsgSessionId) {
          return { element: element, sessionId: element.dataset.agentMsgSessionId };
        }
        const match = String(element.textContent || "").match(/session-[\w-]+/);
        return match ? { element: element, sessionId: match[0] } : null;
      }

      function prepareSenderLinks(root) {
        if (!(root instanceof Element)) return;
        const elements = root.matches(senderSelector)
          ? [root].concat(Array.from(root.querySelectorAll(senderSelector)))
          : Array.from(root.querySelectorAll(senderSelector));
        elements.forEach(function (element) {
          const link = senderLink(element);
          if (!link) return;
          const title = sessionTitle(sessionRow(link.sessionId)) || "@" + link.sessionId;
          if (element.dataset.agentMsgOriginalText === undefined) {
            element.dataset.agentMsgOriginalText = element.textContent || "";
          }
          element.dataset.agentMsgSessionId = link.sessionId;
          element.dataset.agentMsgSenderTitle = title;
          element.textContent = uiText("来自会话 · ", "From Session · ") + title + ":";
          element.classList.add("agent-msg-session-link", "agent-msg-sender-link");
          sessionLinks.add(element);
          element.setAttribute("role", "link");
          element.setAttribute("tabindex", "0");
          element.setAttribute("title", uiText("打开发送方会话", "Open sender session"));
          element.setAttribute("aria-label", uiText("打开发送方会话：", "Open sender session: ") + (title || link.sessionId));
        });
      }

      function prepareRelayCards(root) {
        if (!(root instanceof Element)) return;
        const disclosures = root.matches("[data-disclosure-row]")
          ? [root].concat(Array.from(root.querySelectorAll("[data-disclosure-row]")))
          : Array.from(root.querySelectorAll("[data-disclosure-row]"));
        disclosures.forEach(function (row) {
          if (!String(row.textContent || "").includes("dsh-agent-message")) return;
          if (row.getAttribute("aria-expanded") !== "true") row.click();
        });

        const bodies = root.matches('[data-context-form="relay"]')
          ? [root].concat(Array.from(root.querySelectorAll('[data-context-form="relay"]')))
          : Array.from(root.querySelectorAll('[data-context-form="relay"]'));
        bodies.forEach(function (body) {
          const text = body.querySelector("[data-context-text]");
          if (text === null) return;
          const parsed = stripRelayHeader(text);
          if (parsed === null) return;
          const card = body.closest('[data-chat-flow-kind="context"]') || body.parentElement;
          card?.setAttribute("data-agent-msg-relay-card", "true");
          ensureRelaySender(body, parsed.senderSessionId);
        });

        // Harness 0.2.x 把 followup 投递的 relay 渲染成引发新 turn 的 turn-trigger 行：
        // 正文在展开后才挂载 data-context-text，且原生只显示来源 Session ID。
        // 展开时 MutationObserver 给到的是新挂载的正文子树，所以要连同最近的 trigger 祖先一起处理。
        const triggerOwner = typeof root.closest === "function" ? root.closest('[data-turn-trigger="true"]') : null;
        const triggers = [];
        if (root.matches('[data-turn-trigger="true"]')) triggers.push(root);
        else if (triggerOwner !== null) triggers.push(triggerOwner);
        for (const row of root.querySelectorAll('[data-turn-trigger="true"]')) {
          if (!triggers.includes(row)) triggers.push(row);
        }
        triggers.forEach(function (row) {
          const text = row.querySelector("[data-context-text]");
          if (text === null) return;
          const parsed = stripRelayHeader(text);
          if (parsed === null) return;
          row.setAttribute("data-agent-msg-relay-card", "true");
          ensureRelaySender(row, parsed.senderSessionId);
        });
      }

      /**
       * 解析并剥离模型寻址用的 `<dsh-agent-message>` 协议首行。
       * @param text - 携带 data-context-text 的正文节点
       * @returns 发送方 Session ID 与剥离后的正文；不是 relay 时返回 null
       */
      function stripRelayHeader(text) {
        const raw = String(text.textContent || "");
        const end = raw.indexOf("</dsh-agent-message>");
        if (!raw.startsWith("<dsh-agent-message>") || end < 0) return null;
        let senderSessionId = "";
        try {
          const parsed = JSON.parse(raw.slice("<dsh-agent-message>".length, end));
          if (parsed !== null && typeof parsed === "object" && typeof parsed.senderSessionId === "string") {
            senderSessionId = parsed.senderSessionId;
          }
        } catch (_) {}
        if (text.dataset.agentMsgRelayBody !== "true") {
          text.textContent = raw.slice(end + "</dsh-agent-message>".length).trimStart();
          text.dataset.agentMsgRelayBody = "true";
        }
        return { senderSessionId: senderSessionId };
      }

      /**
       * 在 relay 正文上方补一行可选中的发送方。真正改文案与加键盘可达性交给 prepareSenderLinks。
       * @param container - 承载 relay 正文的节点
       * @param senderSessionId - 已解析出的发送方 Session ID
       */
      function ensureRelaySender(container, senderSessionId) {
        if (senderSessionId === "") return;
        let line = container.querySelector("[data-context-relay-sender]");
        if (line === null) {
          line = document.createElement("p");
          line.setAttribute("data-context-relay-sender", "");
          line.className = "agent-msg-relay-sender";
          const text = container.querySelector("[data-context-text]");
          if (text !== null && text.parentElement !== null) text.parentElement.insertBefore(line, text);
          else container.appendChild(line);
        }
        line.dataset.agentMsgSessionId = senderSessionId;
      }

      function prepare(root) {
        prepareRelayCards(root);
        prepareSenderLinks(root);
      }

      function refreshSenderLinks() {
        sessionLinks.forEach(function (element) {
          if (!element.isConnected) {
            sessionLinks.delete(element);
            return;
          }
          prepareSenderLinks(element);
        });
      }

      function openSender(event) {
        const element = event.target instanceof Element
          ? event.target.closest(".agent-msg-session-link")
          : null;
        const sessionId = element?.dataset.agentMsgSessionId;
        if (!sessionId) return;
        event.preventDefault();
        event.stopPropagation();
        if (ctx.uiWorkspace === undefined || typeof ctx.uiWorkspace.openSession !== "function") return;
        ctx.uiWorkspace.openSession(sessionId);
      }

      function onKeyDown(event) {
        if (event.key !== "Enter" && event.key !== " ") return;
        openSender(event);
      }

      function legacyCopyText(text) {
        let ta;
        try {
          ta = document.createElement("textarea");
          ta.value = text;
          ta.setAttribute("readonly", "");
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          return document.execCommand("copy");
        } catch (_) {
          return false;
        } finally {
          ta?.remove();
        }
      }

      async function copyText(text) {
        try {
          if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
          }
        } catch (_) {}
        return legacyCopyText(text);
      }

      function CopyButton(props) {
        useLocale();
        const [copyState, setCopyState] = React.useState("idle");
        async function onClick() {
          const text = String(props.sessionId || "");
          if (text === "") return;
          setCopyState(await copyText(text) ? "copied" : "failed");
          ctx.timeout(function () { setCopyState("idle"); }, 2000);
        }
        function onMouseLeave() { setCopyState("idle"); }
        return React.createElement("button", {
          type: "button",
          onClick: onClick,
          onMouseLeave: onMouseLeave,
          title: uiText("复制会话 ID", "Copy session ID"),
          "aria-label": uiText("复制会话 ID", "Copy session ID"),
          className: "agent-msg-copy-id"
        }, copyState === "copied"
          ? uiText("已复制", "Copied")
          : copyState === "failed"
            ? uiText("复制失败", "Copy failed")
            : uiText("复制ID", "Copy ID"));
      }

      ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register(
        { name: "conversation.session.header.actions", id: "copy-session-id", order: 30 },
        (props) => React.createElement(CopyButton, { sessionId: props.sessionId })
      ));

      const css =
        ".agent-msg-copy-id { cursor: pointer; font-size: 12px; line-height: 1; padding: 5px 10px; border: 1px solid rgba(127,127,127,.35); border-radius: 6px; background: transparent; color: inherit; opacity: .85; } " +
        ".agent-msg-copy-id:hover { opacity: 1; border-color: rgba(127,127,127,.7); } " +
        ".agent-msg-session-link { cursor: pointer; text-decoration: none; } " +
        "[data-agent-msg-relay-card] [data-disclosure-row] { display: none !important; } " +
        "[data-agent-msg-relay-card] [data-context-form=\"relay\"] { width: fit-content; max-width: min(78%, 760px); max-height: none; margin: 0; padding: 14px 16px; overflow: visible; border: 1px solid rgba(127,127,127,.24); border-radius: 16px 16px 16px 4px; background: var(--dsw-alias-markdown-code-block); color: var(--dsw-alias-label-primary); font: inherit; } " +
        "[data-agent-msg-relay-card] [data-context-relay-sender] { display: block; width: fit-content; margin: 0 0 8px; color: var(--dsw-alias-state-business-primary); font-size: 13px; font-weight: 600; line-height: 1.5; } " +
        "[data-agent-msg-relay-card] [data-context-text] { margin: 0; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere; color: inherit; font: inherit; } " +
        ".agent-msg-session-link:hover { text-decoration: underline; text-underline-offset: 3px; } " +
        ".agent-msg-session-link:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; border-radius: 2px; }";
      const tag = document.createElement("style");
      tag.setAttribute("data-plugin", name);
      tag.textContent = css;
      document.head.appendChild(tag);
      prepare(document.body);
      const observer = new MutationObserver(function (records) {
        records.forEach(function (record) {
          record.removedNodes.forEach(cleanupRoots);
          record.addedNodes.forEach(prepare);
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const unsubscribeSessions = ctx.sessions.list.subscribe(refreshSenderLinks);
      const unsubscribeLocale = ctx.locale.subscribe(refreshSenderLinks);
      document.addEventListener("click", openSender);
      document.addEventListener("keydown", onKeyDown);
      ctx.effect(() => () => {
        observer.disconnect();
        unsubscribeSessions();
        unsubscribeLocale();
        document.removeEventListener("click", openSender);
        document.removeEventListener("keydown", onKeyDown);
        sessionLinks.forEach(restoreSender);
        sessionLinks.clear();
        tag.remove();
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
