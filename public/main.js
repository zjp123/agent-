// 非原生fetch 流式返回 + 可中断 + post
// 原生EventSource 只支持get
// EventSource是一种服务器推送技术，只允许服务器向客户端发送消息，而不允许客户端向服务器发送消息
import { fetchEventSource } from "https://esm.sh/@microsoft/fetch-event-source@2.0.1";

/*
const es = new EventSource("/api/aiAgent/stream?question=北京天气");

es.addEventListener("message", (event) => {
  console.log("默认事件:", event.data);
});

es.addEventListener("progress", (event) => {
  console.log("自定义 progress 事件:", event.data);
});
*/
// 前端单次---http--后端一次性返回
//“前端发一个问题，后端持续吐 token”场景，优先 SSE/ fetchEventSource ； 
// 响应类型 content-type text/event-stream; charset=utf-8

// 只有当你需要真正双向实时交互时再上 WebSocket。
const questionInput = document.querySelector("#question");
const output = document.querySelector("#output");
const loadingEl = document.querySelector("#loading");
const sendBtn = document.querySelector("#sendBtn");
const stopBtn = document.querySelector("#stopBtn");
const authActionEl = document.querySelector("#authAction");
const authBtn = document.querySelector("#authBtn");
const authLink = document.querySelector("#authLink");

let controller = null;
let currentAuthorizeUrl = "";

function extractAuthorizeUrl(text) {
  const input = String(text || "");
  const matches = input.match(/https?:\/\/[^\s)>\]]+/gi) || [];
  const exact = matches.find((url) =>
    /\/open-apis\/authen\/v1\/authorize\?/i.test(url)
  );
  if (exact) {
    return exact;
  }
  return matches[0] || "";
}

function renderAuthorizeActionByText(text) {
  const authorizeUrl = extractAuthorizeUrl(text);
  currentAuthorizeUrl = authorizeUrl;
  if (!authorizeUrl) {
    authActionEl.classList.remove("active");
    authLink.textContent = "";
    authLink.removeAttribute("href");
    return;
  }
  authActionEl.classList.add("active");
  authLink.href = authorizeUrl;
  authLink.textContent = authorizeUrl;
}

function setLoading(isLoading) {
  sendBtn.disabled = isLoading;
  stopBtn.disabled = !isLoading;
  if (isLoading) {
    loadingEl.classList.add("active");
  } else {
    loadingEl.classList.remove("active");
  }
}

sendBtn.addEventListener("click", async () => {
  const question = questionInput.value.trim();
  if (!question) {
    output.textContent = "请输入问题后再发送。";
    renderAuthorizeActionByText(output.textContent);
    return;
  }

  controller = new AbortController();
  output.textContent = "";
  renderAuthorizeActionByText("");
  setLoading(true);

  try {
    await fetchEventSource("/api/aiAgent/ask", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ question }),
      signal: controller.signal,
      openWhenHidden: true,
      onmessage(event) {
        if (event.data === "[DONE]") {
          setLoading(false);
          renderAuthorizeActionByText(output.textContent);
          return;
        }
        output.textContent += decodeURIComponent(event.data);
        renderAuthorizeActionByText(output.textContent);
      },
      onclose() {
        setLoading(false);
        renderAuthorizeActionByText(output.textContent);
      },
      onerror() {
        setLoading(false);
        throw new Error("请求失败");
      },
    });
  } catch (error) {
    output.textContent += `\n\n[错误] ${error.message || "未知异常"}`;
    renderAuthorizeActionByText(output.textContent);
    setLoading(false);
  }
});

stopBtn.addEventListener("click", () => {
  if (controller) {
    controller.abort();
    controller = null;
  }
  setLoading(false);
});

authBtn.addEventListener("click", () => {
  if (!currentAuthorizeUrl) {
    return;
  }
  window.open(currentAuthorizeUrl, "_blank", "noopener,noreferrer");
});

setLoading(false);
