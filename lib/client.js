window.__ModuleLoader__.load({
  id: "dsh-agent-message",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    const name = "dsh-agent-message-client";
    const inject = ["slots", "sessions", "uiWorkspace", "locale"];

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

      /**
       * Host Config 表单（0.2.2 起由插件自己挂到插件页）。
       *
       * Harness 0.2.2 的插件管理页按 `plugins.bundle.config` 槽（key = 包名）在插件详情页
       * 「详细介绍」与「包含的组件」之间渲染插件包自己的配置区；配置值仍由 Harness
       * settings 文档持有，这里只负责渲染 `showTechnicalDetails` 开关并调用
       * `configForms` 的写入队列。
       */
      const CONFIG_NAMESPACE = "agent-message";
      const CONFIG_BUNDLE_KEY = "dsh-agent-message";

      function ConfigFormBody(props) {
        useLocale();
        const form = props.form;
        const subscribe = React.useCallback(function (listener) { return form.subscribe(listener); }, [form]);
        const getSnapshot = React.useCallback(function () { return form.getSnapshot(); }, [form]);
        const state = React.useSyncExternalStore(subscribe, getSnapshot);
        const [busy, setBusy] = React.useState(false);
        const [failure, setFailure] = React.useState("");

        if (state.status === "loading") {
          return React.createElement("p", { className: "agent-msg-config-hint" },
            uiText("正在读取插件配置…", "Reading plugin configuration…"));
        }
        if (state.status === "unavailable") {
          return React.createElement("p", { className: "agent-msg-config-hint" },
            uiText("当前 Harness 未向客户端暴露本插件的配置。", "This Harness does not expose this plugin's configuration to the client."));
        }

        const value = state.value ?? {};
        const checked = value.showTechnicalDetails !== false;
        const disabled = busy || state.writable === false;
        async function onChange(event) {
          const next = event.target.checked;
          setBusy(true);
          setFailure("");
          try {
            const accepted = await form.set("showTechnicalDetails", next);
            if (!accepted) setFailure(uiText("保存失败：配置文档当前不可写。", "Save failed: the settings document is not writable."));
          } catch (error) {
            setFailure(String(error?.message ?? error));
          } finally {
            setBusy(false);
          }
        }

        return React.createElement("div", { className: "agent-msg-config" }, [
          React.createElement("label", { className: "agent-msg-config-row", key: "toggle" }, [
            React.createElement("input", {
              type: "checkbox",
              checked: checked,
              disabled: disabled,
              onChange: onChange,
              key: "input"
            }),
            React.createElement("span", { key: "label" },
              uiText("在投递结果卡片中显示技术细节", "Show technical details on delivery result cards"))
          ]),
          React.createElement("p", { className: "agent-msg-config-hint", key: "hint" },
            uiText(
              "控制 send_agent_message 的结果卡片是否附带投递模式与目标运行状态；messageId 始终显示。",
              "Controls whether send_agent_message result cards include the delivery mode and target runtime status; the messageId always shows."
            )),
          failure === "" ? null : React.createElement("p", {
            className: "agent-msg-config-error",
            role: "alert",
            key: "error"
          }, failure)
        ]);
      }

      function DeliveryCardConfig(props) {
        useLocale();
        if (props.view !== "page") return null;
        return React.createElement("div", { className: "agent-msg-config" }, [
          React.createElement("h4", { className: "agent-msg-config-title", key: "title" },
            uiText("投递卡片", "Delivery card")),
          props.liveForm === undefined
            ? React.createElement("p", { className: "agent-msg-config-hint", key: "hint" },
              uiText("插件配置入口暂不可用。", "Plugin configuration is not available yet."))
            : React.createElement(ConfigFormBody, { form: props.liveForm, key: "form" })
        ]);
      }

      ctx.inject(["configForms"], (scope) => {
        scope.slots.inject("plugins.bundle.config", () => scope.slots.register({
          name: "plugins.bundle.config",
          key: CONFIG_BUNDLE_KEY,
          inject: () => ({ liveForm: scope.configForms.get(CONFIG_NAMESPACE) })
        }, DeliveryCardConfig));
      });

      const css =
        ".agent-msg-session-link { cursor: pointer; text-decoration: none; } " +
        ".agent-msg-config { display: flex; flex-direction: column; gap: 8px; } " +
        ".agent-msg-config-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.5; } " +
        ".agent-msg-config-row { display: flex; align-items: center; gap: 8px; cursor: pointer; } " +
        ".agent-msg-config-row input { cursor: pointer; } " +
        ".agent-msg-config-hint { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 1.5; } " +
        ".agent-msg-config-error { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 13px; line-height: 1.5; } " +
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
