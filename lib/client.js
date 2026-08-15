window.__ModuleLoader__.load({
  id: "dsh-agent-message",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const { createRoot } = require("react-dom/client");
    const { IconQueueOutline14, StateDot } = require("@deepseek-ai/dsh-client-ui-primitives");

    const name = "dsh-agent-message-client";
    const inject = ["slots", "timer", "sessions", "inputTriggers", "workspaces"];

    function apply(ctx) {
      const senderSelector = '[data-ref-chip="subagent"], [data-context-relay-sender]';
      const referenceSource = "agent-message-session";
      const candidateRows = new WeakMap();
      const mountedRoots = new Map();
      const workspaces = ctx.get("workspaces");

      function uiText(zh, en) {
        const language = String(document.documentElement.lang || navigator.language || "zh").toLowerCase();
        return language.startsWith("zh") ? zh : en;
      }

      function sessionRows(includeArchived) {
        const snapshot = ctx.sessions.list.getSnapshot();
        const archived = new Set(workspaces?.list.getSnapshot().archivedSessionIds || []);
        return snapshot.ids
          .map(function (id) { return snapshot.byId[id]; })
          .filter(function (row) {
            return row && !row.blank && row.origin !== "subagent"
              && (includeArchived || !archived.has(row.id));
          });
      }

      function sessionRow(id) {
        return ctx.sessions.list.getSnapshot().byId[id];
      }

      function sessionTitle(row) {
        return String(row?.displayTitle || row?.title || row?.id || "");
      }

      function compactSessionTitle(row) {
        const chars = Array.from(sessionTitle(row));
        return chars.length > 40 ? chars.slice(0, 39).join("") + "…" : chars.join("");
      }

      function renderInto(host, content) {
        let root = mountedRoots.get(host);
        if (!root) {
          root = createRoot(host);
          mountedRoots.set(host, root);
        }
        root.render(content);
      }

      function cleanupRoots(node) {
        mountedRoots.forEach(function (root, host) {
          if (node === host || (node instanceof Element && node.contains(host))) {
            root.unmount();
            mountedRoots.delete(host);
          }
        });
      }

      function SessionActivity(props) {
        return props.running
          ? React.createElement(StateDot, { state: "done", size: 10, className: "agent-msg-status-dot" })
          : React.createElement("span", { className: "agent-msg-status-dot agent-msg-status-dot-idle", "aria-hidden": "true" });
      }

      function SessionReference(props) {
        return React.createElement("span", { className: "agent-msg-reference-content" },
          React.createElement(IconQueueOutline14, { size: 14, className: "agent-msg-session-icon" }),
          React.createElement("span", { className: "agent-msg-reference-title" }, "@" + sessionTitle(props.row)));
      }

      function enhanceReferenceHost(element, row) {
        let host = element.querySelector(":scope > .agent-msg-reference-host");
        if (!host) {
          element.textContent = "";
          host = document.createElement("span");
          host.className = "agent-msg-reference-host";
          element.appendChild(host);
        }
        renderInto(host, React.createElement(SessionReference, { row: row }));
      }

      const inputTriggers = ctx.get("inputTriggers");
      if (inputTriggers !== undefined) {
        ctx.effect(() => inputTriggers.registerSource({
          trigger: "@",
          name: referenceSource,
          order: 2,
          async candidates(session, request) {
            if (request.position !== "leading") return [];
            const query = String(request.query || "").toLowerCase();
            return sessionRows(false)
              .filter(function (row) {
                return String(row.id) !== String(session.sessionId)
                  && (query === "" || sessionTitle(row).toLowerCase().includes(query));
              })
              .sort(function (a, b) {
                if (a.running !== b.running) return a.running ? -1 : 1;
                return sessionTitle(a).localeCompare(sessionTitle(b));
              })
              .map(function (row) {
                const candidate = {
                  name: sessionTitle(row),
                  description: row.running ? uiText("运行中", "Running") : uiText("空闲", "Idle"),
                  icon: "",
                };
                candidateRows.set(candidate, row);
                return candidate;
              });
          },
          onPick({ candidate, session }) {
            const row = candidateRows.get(candidate);
            if (!row) return undefined;
            const label = "@" + compactSessionTitle(row);
            return {
              claim: {
                token: label + " ",
                hint: uiText("输入要处理的内容", "Describe what to do"),
                async submit(args) {
                  const content = String(args || "").trim();
                  if (content === "") return { kind: "error", text: uiText("请输入要处理的内容", "Describe what to do") };
                  const binding = ctx.sessions.binding(session.sessionId);
                  if (!binding) return { kind: "error", text: uiText("当前会话不可用", "Current session is unavailable") };
                  const result = await binding.session.prompt([{
                    type: "text",
                    text: "@" + String(row.id) + " " + content,
                  }], "queue");
                  return result.ok
                    ? { kind: "success" }
                    : { kind: "error", text: result.error.message };
                },
              },
            };
          },
        }), "dsh-agent-message: @ session source");
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
          element.classList.add("agent-msg-session-link", "agent-msg-sender-link");
          element.setAttribute("role", "link");
          element.setAttribute("tabindex", "0");
          element.setAttribute("title", "打开发送方会话");
          element.setAttribute("aria-label", "打开发送方会话：" + (title || link.sessionId));
        });
      }

      function prepareSessionReferences(root) {
        if (!(root instanceof Element)) return;
        const elements = root.matches('[data-ref-chip="subagent"]')
          ? [root].concat(Array.from(root.querySelectorAll('[data-ref-chip="subagent"]')))
          : Array.from(root.querySelectorAll('[data-ref-chip="subagent"]'));
        elements.forEach(function (element) {
          if (element.classList.contains("agent-msg-sender-link")) return;
          const id = element.dataset.agentMsgSessionId
            || String(element.textContent || "").trim().match(/^@(session-[\w-]+)$/)?.[1];
          const row = id ? sessionRow(id) : undefined;
          if (!id || !row) return;
          element.dataset.agentMsgSessionId = id;
          element.classList.add("agent-msg-session-link", "agent-msg-reference-link");
          element.setAttribute("role", "link");
          element.setAttribute("tabindex", "0");
          element.setAttribute("title", uiText("打开引用会话", "Open referenced session"));
          element.setAttribute("aria-label", uiText("打开引用会话：", "Open referenced session: ") + sessionTitle(row));
          enhanceReferenceHost(element, row);
        });
      }

      function prepareSessionMenu(root) {
        if (!(root instanceof Element)) return;
        const menu = root.matches('[role="listbox"]') ? root : root.closest('[role="listbox"]') || root.querySelector('[role="listbox"]');
        if (!menu) return;
        const group = menu.querySelector('[data-source="' + referenceSource + '"]');
        if (!group) return;
        group.textContent = uiText("会话", "Sessions");
        let element = group.nextElementSibling;
        while (element && !element.hasAttribute("data-source")) {
          if (element.matches('button[role="option"]')) {
            element.classList.add("agent-msg-session-candidate");
            const spans = element.querySelectorAll(":scope > span");
            const icon = spans[0];
            const description = spans[2];
            if (icon) {
              icon.classList.add("agent-msg-candidate-icon");
              renderInto(icon, React.createElement(IconQueueOutline14, { size: 14 }));
            }
            if (description) {
              const running = /^(运行中|Running)$/.test(String(description.textContent || "").trim())
                || element.dataset.agentMsgRunning === "true";
              element.dataset.agentMsgRunning = String(running);
              renderInto(description, React.createElement("span", { className: "agent-msg-status-label" },
                React.createElement(SessionActivity, { running: running }),
                React.createElement("span", null, running ? uiText("运行中", "Running") : uiText("空闲", "Idle"))));
            }
          }
          element = element.nextElementSibling;
        }
      }

      function prepare(root) {
        prepareSenderLinks(root);
        prepareSessionReferences(root);
        prepareSessionMenu(root);
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
        ".agent-msg-sender-link[data-ref-chip=\"subagent\"] { display: block; width: fit-content; padding: 0; background: transparent; color: inherit; font-size: 13px; font-weight: 600; line-height: 1.5; } " +
        ".agent-msg-reference-link { display: inline-flex !important; align-items: center; color: var(--dsw-alias-state-business-primary) !important; } " +
        ".agent-msg-reference-host, .agent-msg-reference-content { display: inline-flex; min-width: 0; align-items: center; } " +
        ".agent-msg-reference-content { gap: 5px; max-width: 100%; } " +
        ".agent-msg-reference-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } " +
        ".agent-msg-session-icon, .agent-msg-candidate-icon { display: inline-flex; flex: none; color: var(--dsw-alias-state-business-primary); } " +
        ".agent-msg-status-dot { flex: none; } " +
        ".agent-msg-status-dot-idle { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); opacity: .7; } " +
        ".agent-msg-status-label { display: inline-flex; align-items: center; gap: 6px; } " +
        ".agent-msg-session-candidate { border-radius: 0 !important; } " +
        ".agent-msg-session-candidate > span:nth-child(2) { flex: 1; min-width: 0; max-width: none; } " +
        ".agent-msg-session-candidate > span:nth-child(3) { display: flex; flex: none; justify-content: flex-end; margin-left: auto; } " +
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
      const unsubscribeSessions = ctx.sessions.list.subscribe(function () { prepare(document.body); });
      const unsubscribeWorkspaces = workspaces?.list.subscribe(function () { prepare(document.body); });
      document.addEventListener("click", openSender);
      document.addEventListener("keydown", onKeyDown);
      ctx.effect(() => () => {
        observer.disconnect();
        unsubscribeSessions();
        unsubscribeWorkspaces?.();
        document.removeEventListener("click", openSender);
        document.removeEventListener("keydown", onKeyDown);
        mountedRoots.forEach(function (root) { root.unmount(); });
        mountedRoots.clear();
        tag.remove();
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
