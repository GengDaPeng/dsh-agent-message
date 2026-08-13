window.__ModuleLoader__.load({
  id: "dsh-agent-message",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    const name = "dsh-agent-message-client";
    const inject = ["slots", "timer"];

    function apply(ctx) {
      function copyText(text) {
        let usedClipboard = false;
        try {
          if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(function () {});
            usedClipboard = true;
          }
        } catch (_) {}
        if (usedClipboard) return;
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.setAttribute("readonly", "");
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        } catch (_) {}
      }

      function CopyButton(props) {
        const [copied, setCopied] = React.useState(false);
        function onClick() {
          const text = String(props.sessionId || "");
          if (text === "") return;
          copyText(text);
          setCopied(true);
          ctx.timeout(function () { setCopied(false); }, 2000);
        }
        function onMouseLeave() { setCopied(false); }
        return React.createElement("button", {
          type: "button",
          onClick: onClick,
          onMouseLeave: onMouseLeave,
          title: "复制会话 ID",
          "aria-label": "复制会话 ID",
          className: "agent-msg-copy-id"
        }, copied ? "已复制" : "复制ID");
      }

      ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register(
        { name: "conversation.session.header.actions", id: "copy-session-id", order: 30, label: "复制会话ID" },
        (props) => React.createElement(CopyButton, { sessionId: props.sessionId })
      ));

      const css =
        ".agent-msg-copy-id { cursor: pointer; font-size: 12px; line-height: 1; padding: 5px 10px; border: 1px solid rgba(127,127,127,.35); border-radius: 6px; background: transparent; color: inherit; opacity: .85; } " +
        ".agent-msg-copy-id:hover { opacity: 1; border-color: rgba(127,127,127,.7); }";
      const tag = document.createElement("style");
      tag.setAttribute("data-plugin", name);
      tag.textContent = css;
      document.head.appendChild(tag);
      ctx.effect(() => () => tag.remove());
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
