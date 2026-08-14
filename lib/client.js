window.__ModuleLoader__.load({
  id: "dsh-agent-message",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    const name = "dsh-agent-message-client";
    const inject = ["slots", "timer", "sessions"];

    function apply(ctx) {
      const senderSelector = '[data-ref-chip="subagent"], [data-context-relay-sender]';

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

      function titleFrom(text) {
        const line = String(text || "").split("\n", 1)[0].trim();
        const current = line.match(/^From (?:Session|Agent)(?: ·)? (.+?):(?: @session-[\w-]+)?$/);
        const previous = line.match(/^来自 Agent · (.+)$/);
        const legacy = line.match(/^来自 Agent「(.+)」\s*[·：:]?$/);
        return (current || previous || legacy)?.[1]?.trim() || "";
      }

      function senderTitle(element) {
        if (element.dataset.agentMsgSenderTitle) return element.dataset.agentMsgSenderTitle;
        const label = element.previousElementSibling;
        const title = titleFrom(label?.textContent);
        if (title && label) {
          label.textContent = "";
          label.classList.add("agent-msg-sender-prefix");
        }
        return title;
      }

      function prepareSenderLinks(root) {
        if (!(root instanceof Element)) return;
        const elements = root.matches(senderSelector)
          ? [root].concat(Array.from(root.querySelectorAll(senderSelector)))
          : Array.from(root.querySelectorAll(senderSelector));
        elements.forEach(function (element) {
          const link = senderLink(element);
          if (!link) return;
          const relay = element.matches("[data-context-relay-sender]");
          const title = relay ? "" : senderTitle(element);
          if (!relay && !title) return;
          element.dataset.agentMsgSessionId = link.sessionId;
          if (title) element.dataset.agentMsgSenderTitle = title;
          element.textContent = relay ? "From session @" + link.sessionId : "From Session · " + title + ":";
          element.classList.add("agent-msg-session-link");
          element.setAttribute("role", "link");
          element.setAttribute("tabindex", "0");
          element.setAttribute("title", "打开发送方会话");
          element.setAttribute("aria-label", "打开发送方会话：" + (title || link.sessionId));
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
          title: "复制会话 ID",
          "aria-label": "复制会话 ID",
          className: "agent-msg-copy-id"
        }, copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制ID");
      }

      ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register(
        { name: "conversation.session.header.actions", id: "copy-session-id", order: 30, label: "复制会话ID" },
        (props) => React.createElement(CopyButton, { sessionId: props.sessionId })
      ));

      const css =
        ".agent-msg-copy-id { cursor: pointer; font-size: 12px; line-height: 1; padding: 5px 10px; border: 1px solid rgba(127,127,127,.35); border-radius: 6px; background: transparent; color: inherit; opacity: .85; } " +
        ".agent-msg-copy-id:hover { opacity: 1; border-color: rgba(127,127,127,.7); } " +
        ".agent-msg-sender-prefix { display: none !important; } " +
        ".agent-msg-session-link { cursor: pointer; text-decoration: none; } " +
        ".agent-msg-session-link[data-ref-chip=\"subagent\"] { display: block; width: fit-content; padding: 0; background: transparent; color: inherit; font-size: 13px; font-weight: 600; line-height: 1.5; } " +
        ".agent-msg-session-link:hover { text-decoration: underline; text-underline-offset: 3px; } " +
        ".agent-msg-session-link:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; border-radius: 2px; }";
      const tag = document.createElement("style");
      tag.setAttribute("data-plugin", name);
      tag.textContent = css;
      document.head.appendChild(tag);
      prepareSenderLinks(document.body);
      const observer = new MutationObserver(function (records) {
        records.forEach(function (record) {
          record.addedNodes.forEach(prepareSenderLinks);
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
      document.addEventListener("click", openSender);
      document.addEventListener("keydown", onKeyDown);
      ctx.effect(() => () => {
        observer.disconnect();
        document.removeEventListener("click", openSender);
        document.removeEventListener("keydown", onKeyDown);
        tag.remove();
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
