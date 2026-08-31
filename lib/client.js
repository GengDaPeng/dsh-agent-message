window.__ModuleLoader__.load({
  id: "dsh-agent-message",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    const name = "dsh-agent-message-client";
    const inject = ["slots", "timer", "sessions", "settingsScope", "locale"];

    function apply(ctx) {
      const senderSelector = "[data-context-relay-sender]";
      const sessionLinks = new Set();
      const subscribeLocale = function (listener) { return ctx.locale.subscribe(listener); };
      const getLocaleSnapshot = function () { return ctx.locale.getSnapshot(); };

      const AGENT_MESSAGE_SETTINGS_NAMESPACE = "agent-message";

      function useLocale() {
        React.useSyncExternalStore(subscribeLocale, getLocaleSnapshot);
      }

      function AgentMessageSettingsCard(props) {
        useLocale();
        const snapshot = props.useAgentMessageSettings(function (value) { return value; });
        const current = snapshot.value?.showTechnicalDetails !== false;
        const [draft, setDraft] = React.useState(current);
        const [saving, setSaving] = React.useState(false);
        const [error, setError] = React.useState(false);
        React.useEffect(function () { setDraft(current); }, [snapshot.revision, current]);
        const dirty = draft !== current;
        const writable = snapshot.writable && snapshot.status === "ready";
        function save() {
          if (!dirty || saving || !writable) return;
          setSaving(true);
          setError(false);
          props.setShowTechnicalDetails(draft)
            .catch(function () { setError(true); })
            .finally(function () { setSaving(false); });
        }
        function reset() {
          if (!writable) return;
          setDraft(snapshot.base?.showTechnicalDetails !== false);
        }
        return React.createElement("section", { style: { padding: "12px 0", maxWidth: "760px" } },
          React.createElement("h3", { style: { margin: "0 0 4px" } }, uiText("跨会话消息", "Agent messages")),
          React.createElement("p", { style: { color: "var(--dsw-alias-label-tertiary)", margin: "0 0 12px", fontSize: "13px" } }, uiText("控制投递卡片是否显示传输细节。messageId 始终保留。", "Control transport details in delivery cards. The messageId is always kept.")),
          React.createElement("label", { style: { display: "flex", gap: "8px", alignItems: "center" } },
            React.createElement("input", { type: "checkbox", checked: draft, disabled: !writable, onChange: function (event) { setDraft(event.target.checked); } }),
            uiText("显示投递模式和目标运行状态", "Show delivery mode and target runtime status")),
          error ? React.createElement("p", { role: "alert", style: { color: "var(--dsw-alias-state-error)", margin: "10px 0 0", fontSize: "13px" } }, uiText("保存失败，设置可能已被其他页面修改。", "Save failed; the setting may have changed elsewhere.")) : null,
          React.createElement("div", { style: { display: "flex", gap: "8px", marginTop: "14px" } },
            React.createElement("button", { type: "button", disabled: !dirty || saving || !writable, onClick: reset }, uiText("恢复默认", "Reset")),
            React.createElement("button", { type: "button", disabled: !dirty || saving || !writable, onClick: save }, saving ? uiText("保存中…", "Saving…") : uiText("保存", "Save")))
        );
      }

      if (ctx.settingsScope !== undefined && ctx.slots !== undefined) {
        const scope = ctx.settingsScope.bind({ namespace: AGENT_MESSAGE_SETTINGS_NAMESPACE });
        const agentMessageSettingsStore = {
          getSnapshot: function () { return scope.getSnapshot(); },
          subscribe: function (listener) { return scope.subscribe(listener); },
        };
        ctx.slots.inject("settings.plugin.item", function () {
          return ctx.slots.register({
            name: "settings.plugin.item",
            key: AGENT_MESSAGE_SETTINGS_NAMESPACE,
            inject: function () {
              return {
                hooks: { agentMessageSettings: agentMessageSettingsStore },
                setShowTechnicalDetails: function (value) { return scope.set("showTechnicalDetails", value); },
              };
            },
          }, AgentMessageSettingsCard);
        });
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
          const raw = String(text?.textContent || "");
          const end = raw.indexOf("</dsh-agent-message>");
          if (!raw.startsWith("<dsh-agent-message>") || end < 0) return;
          const card = body.closest('[data-chat-flow-kind="context"]') || body.parentElement;
          card?.setAttribute("data-agent-msg-relay-card", "true");
          if (text.dataset.agentMsgRelayBody !== "true") {
            text.textContent = raw.slice(end + "</dsh-agent-message>".length).trimStart();
            text.dataset.agentMsgRelayBody = "true";
          }
        });
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
        ctx.sessions.open(sessionId);
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
        { name: "conversation.session.header.actions", id: "copy-session-id", order: 30, label: uiText("复制会话ID", "Copy session ID") },
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
