// js/app.js
(() => {
  // --- CONFIG (desde config.js) ---
  const { API_BASE } = window.APP_CONFIG || { API_BASE: "" };

  const urlParams = new URLSearchParams(location.search);
  const MAC_FROM_URL = (urlParams.get("mac") || "AA:BB:CC:DD:EE:FF").toUpperCase();
  const BUS_ID_FROM_URL = urlParams.get("bus_id") || "BUS-001";
  const ORDER_ID_FROM_URL = urlParams.get("order_id");
  const FAILED_FLAG = urlParams.get("failed");

  // Estado global interno
  let selectedPlan = null;
  let selectedPrice = 0;

  // Helpers
  function isWebView() {
    const ua = navigator.userAgent || "";
    const isAndroidWV = /Android/i.test(ua) && /\; wv\)/i.test(ua);
    const isIOSWV = /iPhone|iPad|iPod/i.test(ua) && !/Safari/i.test(ua);
    return isAndroidWV || isIOSWV;
  }

  function openExternal(url) {
    if (!url) return;
    const ua = navigator.userAgent || "";
    const isAndroid = /Android/i.test(ua);
    if (isAndroid) {
      const stripped = url.replace(/^https?:\/\//, "");
      const intent = `intent://${stripped}#Intent;scheme=https;package=com.android.chrome;end`;
      location.href = intent;
      setTimeout(() => { try { window.open(url, "_blank", "noopener,noreferrer"); } catch (e) {} }, 600);
      return;
    }
    try { window.location.href = url; } catch (e) {}
    setTimeout(() => {
      const a = document.createElement("a");
      a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = "Abrir Mercado Pago";
      a.style = "display:block;margin:16px 0;text-align:center;font:16px sans-serif;";
      document.body.appendChild(a);
    }, 400);
  }

  async function pollOrder(orderId, { intervalMs = 2000, maxMs = 120000 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      try {
        const r = await fetch(`${API_BASE}/orders/${orderId}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (data.status === "approved") return { ok: true, data };
        if (data.status === "rejected") return { ok: false, data };
        await new Promise((res) => setTimeout(res, intervalMs));
      } catch {
        await new Promise((res) => setTimeout(res, intervalMs));
      }
    }
    return { timeout: true };
  }

  function mapPlanFromBackend(plan) {
    if (plan === "PAID_1H") return "1hora";
    if (plan === "PAID_12H") return "12horas";
    if (plan === "PAID_24H") return "24horas";
    return "12horas";
  }

  function mapPlanToApi(planUi) {
    if (planUi === "1hora") return "PAID_1H";
    if (planUi === "12horas") return "PAID_12H";
    if (planUi === "24horas") return "PAID_24H";
    throw new Error("Plan inválido");
  }

  function updatePayButton() {
    const payButton = document.getElementById("payButton");
    const userName = document.getElementById("userName").value.trim();
    const userEmail = document.getElementById("userEmail").value.trim();
    const userPhone = document.getElementById("userPhone").value.trim();

    if (!selectedPlan) {
      payButton.disabled = true;
      payButton.textContent = "💳 Selecciona un plan para continuar";
      return;
    }
    if (!userName || !userEmail || !userPhone) {
      payButton.disabled = true;
      payButton.textContent = "💳 Completa tus datos";
      return;
    }
    payButton.disabled = false;
    payButton.textContent = `💳 Pagar $${selectedPrice.toLocaleString()} con MercadoPago`;
  }

  async function startPaidPolling() {
    const id = window.__lastOrderId;
    if (!id) return;
    const loading = document.getElementById("loading");
    if (loading) loading.style.display = "block";
    const res = await pollOrder(id, { intervalMs: 3000, maxMs: 180000 });
    if (loading) loading.style.display = "none";
    if (res?.ok) {
      const planUi = mapPlanFromBackend(res.data.plan);
      showResultApproved(planUi);
    } else if (res?.timeout) {
      alert("Aún no recibimos confirmación. Volvé desde MP y actualizá esta página.");
    } else {
      alert("El pago fue rechazado o cancelado. Probá nuevamente.");
    }
  }

  function openExternalAndPoll(e) {
    if (e) e.preventDefault();
    if (!window.__lastInitPoint || !window.__lastOrderId) {
      alert("Primero tocá ‘Pagar’ para generar la orden.");
      return;
    }
    openExternal(window.__lastInitPoint);
    startPaidPolling();
  }

  function showResultApproved() {
    const loading = document.getElementById("loading");
    if (loading) loading.style.display = "none";
    document.getElementById("successMessage").style.display = "block";
  }

  // --- API público usado por el HTML ---
  function selectPlan(plan, price) {
    document.querySelectorAll(".payment-option").forEach((o) => o.classList.remove("selected"));
    document.querySelector(`[data-plan="${plan}"]`)?.classList.add("selected");
    selectedPlan = plan;
    selectedPrice = price;
    const wallets = document.querySelector(".digital-wallets");
    const badges = document.querySelector(".security-badges");
    if (wallets) wallets.style.display = "none";
    if (badges) badges.style.display = "none";
    updatePayButton();
  }

  async function processPayment() {
    const userName = document.getElementById("userName").value.trim();
    const userEmail = document.getElementById("userEmail").value.trim();
    const userPhone = document.getElementById("userPhone").value.trim();
    if (!selectedPlan) { alert("Selecciona un plan."); return; }
    if (!userName || !userEmail || !userPhone) { alert("Completá nombre, email y teléfono."); return; }

    const planApi = mapPlanToApi(selectedPlan);
    const loading = document.getElementById("loading");
    const payBtn = document.getElementById("payButton");
    if (loading) loading.style.display = "block";
    if (payBtn) payBtn.disabled = true;

    try {
      const resp = await fetch(`${API_BASE}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: planApi, mac: MAC_FROM_URL, bus_id: BUS_ID_FROM_URL }),
      });

      if (resp.status === 429) {
        const data = await resp.json().catch(() => ({}));
        const retryAt = data?.retry_at ? `\n\nPodrás reintentar: ${data.retry_at}` : "";
        alert("FREE no disponible aún (cooldown activo)." + retryAt);
        throw new Error("Cooldown FREE");
      }

      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Error backend (${resp.status}): ${txt}`);
      }

      const data = await resp.json(); // { order_id, status, init_point }
      const initPoint = data.init_point;
      if (!initPoint) throw new Error("No llegó init_point desde el backend.");

      window.__lastInitPoint = initPoint;
      window.__lastOrderId = data.order_id;

      // Mostrar panel y link grande para copiar
      const hint = document.getElementById("externalHint");
      const rawBox = document.getElementById("rawLinkBox");
      const raw = document.getElementById("rawLink");
      if (hint) hint.style.display = "block";
      if (raw && rawBox) { raw.textContent = initPoint; rawBox.style.display = "block"; }

      // Copiar enlace
      const copyBtn = document.getElementById("copyLinkBtn");
      if (copyBtn) {
        copyBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(initPoint);
            copyBtn.textContent = "✅ Copiado";
            setTimeout(() => (copyBtn.textContent = "📋 Copiar enlace"), 1500);
          } catch {
            const ta = document.createElement("textarea");
            ta.value = initPoint; document.body.appendChild(ta);
            ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
            copyBtn.textContent = "✅ Copiado";
            setTimeout(() => (copyBtn.textContent = "📋 Copiar enlace"), 1500);
          }
        };
      }

      if (loading) loading.style.display = "none";
      if (payBtn) payBtn.disabled = false;
    } catch (err) {
      console.error(err);
      alert("No se pudo iniciar el proceso. " + (err?.message || err));
      if (loading) loading.style.display = "none";
      if (payBtn) payBtn.disabled = false;
    }
  }

  // Eventos
  document.getElementById("userName").addEventListener("input", updatePayButton);
  document.getElementById("userEmail").addEventListener("input", updatePayButton);
  document.getElementById("userPhone").addEventListener("input", updatePayButton);

  document.getElementById("userPhone").addEventListener("input", function (e) {
    let value = e.target.value.replace(/\D/g, "");
    if (value.length > 0) {
      if (value.length <= 2) value = `+${value}`;
      else if (value.length <= 4) value = `+${value.slice(0, 2)} ${value.slice(2)}`;
      else if (value.length <= 6) value = `+${value.slice(0, 2)} ${value.slice(2, 4)} ${value.slice(4)}`;
      else value = `+${value.slice(0, 2)} ${value.slice(2, 4)} ${value.slice(4, 6)} ${value.slice(6, 10)}-${value.slice(10, 14)}`;
    }
    e.target.value = value;
  });

  document.getElementById("userEmail").addEventListener("blur", function (e) {
    const email = e.target.value;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    e.target.style.borderColor = email && !emailRegex.test(email) ? "#ff4757" : "rgba(255, 255, 255, 0.3)";
    if (email && !emailRegex.test(email)) alert("Por favor ingresa un email válido");
  });

  window.addEventListener("load", () => {
    const pay = document.getElementById("payButton");
    if (pay) pay.disabled = true;
    updatePayButton();
  });

  document.addEventListener("keypress", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      const pb = document.getElementById("payButton");
      if (pb && !pb.disabled) processPayment();
    }
  });

  // Si volvimos desde MP con order_id: chequea resultado
  (async function handleReturnFromMP() {
    if (!ORDER_ID_FROM_URL) return;
    const loading = document.getElementById("loading");
    const payBtn = document.getElementById("payButton");
    if (loading) loading.style.display = "block";
    if (payBtn) payBtn.disabled = true;

    if (FAILED_FLAG) console.log("MP back_url venía con failed=1");

    const res = await pollOrder(ORDER_ID_FROM_URL);
    if (res?.ok) {
      const planUi = mapPlanFromBackend(res.data.plan);
      showResultApproved(planUi);
    } else if (res?.timeout) {
      alert("Aún no recibimos confirmación. Actualizá la página en unos segundos.");
      if (loading) loading.style.display = "none";
      if (payBtn) payBtn.disabled = false;
    } else {
      alert("El pago no se aprobó. Intentá nuevamente.");
      if (payBtn) payBtn.disabled = false;
      if (loading) loading.style.display = "none";
    }
  })();

  // Exponer funciones usadas por el HTML
  window.selectPlan = selectPlan;
  window.processPayment = processPayment;
  window.openExternalAndPoll = openExternalAndPoll;
})();