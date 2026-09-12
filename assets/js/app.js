// FIC Colombia — comparador de Fondos de Inversión Colectiva
// Fuente: Superintendencia Financiera de Colombia, dataset qhpu-8ixx (datos.gov.co / Socrata).
// Sin backend: el API de Socrata expone CORS abierto, todo corre en el navegador.

const SODA_BASE = "https://www.datos.gov.co/resource/qhpu-8ixx.json";
const VENTANA_RIESGO_DIAS = 90; // ventana usada para volatilidad y sparkline

const el = (id) => document.getElementById(id);

const fmtCOP = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (n >= 1e12) return "$" + (n / 1e12).toFixed(1) + " billones";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + " mil M";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + " M";
  return "$" + n.toLocaleString("es-CO", { maximumFractionDigits: 0 });
};
const fmtPct = (n, digits = 1) =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
const fmtNum = (n) => (n === null || n === undefined ? "—" : n.toLocaleString("es-CO"));

const PERFIL = {
  CONSERVADOR: { label: "Conservador", clase: "riesgo-bajo", corte: 2.2 },
  MODERADO: { label: "Moderado", clase: "riesgo-medio", corte: 9 },
  AGRESIVO: { label: "Agresivo", clase: "riesgo-alto", corte: Infinity },
};

function perfilDeRiesgo(volAnual) {
  if (volAnual === null || volAnual === undefined || Number.isNaN(volAnual)) return null;
  if (volAnual < PERFIL.CONSERVADOR.corte) return "CONSERVADOR";
  if (volAnual < PERFIL.MODERADO.corte) return "MODERADO";
  return "AGRESIVO";
}

let FONDOS = []; // un registro por fondo (la clase de mayor AUM), enriquecido con riesgo/sparkline
let FILTRO_PERFIL = ""; // "" = todos

async function cargarUniverso() {
  el("estado").textContent = "Consultando el corte más reciente…";

  const fechaResp = await fetch(`${SODA_BASE}?$select=${enc("max(fecha_corte) as m")}`);
  const fechaJson = await fechaResp.json();
  const fechaCorte = fechaJson[0].m;

  el("estado").textContent = `Cargando fondos del corte ${fechaCorte.slice(0, 10)}…`;

  const filasResp = await fetch(
    `${SODA_BASE}?$where=${enc(`fecha_corte='${fechaCorte}'`)}&$limit=3000`
  );
  const filas = await filasResp.json();

  const porFondo = new Map();
  for (const f of filas) {
    const aum = Number(f.valor_fondo_cierre_dia_t || 0);
    const actual = porFondo.get(f.codigo_negocio);
    if (!actual || aum > actual.aum) {
      porFondo.set(f.codigo_negocio, {
        codigo_negocio: f.codigo_negocio,
        tipo_participacion: f.tipo_participacion,
        nombre: f.nombre_patrimonio,
        gestora: f.nombre_entidad,
        categoria: f.nombre_subtipo_patrimonio,
        aum,
        inversionistas: Number(f.numero_inversionistas || 0),
        rentDiaria: Number(f.rentabilidad_diaria),
        rentMensual: Number(f.rentabilidad_mensual),
        rentSemestral: Number(f.rentabilidad_semestral),
        rentAnual: Number(f.rentabilidad_anual),
        aportes: Number(f.aportes_recibidos || 0),
        retiros: Number(f.retiros_redenciones || 0),
        valorUnidad: Number(f.valor_unidad_operaciones),
        fechaCorte,
      });
    }
  }

  FONDOS = [...porFondo.values()].filter((f) => f.aum > 0);
  el("estado").textContent = `Calculando riesgo con los últimos ${VENTANA_RIESGO_DIAS} días…`;

  await enriquecerConRiesgo(fechaCorte);

  poblarResumenMercado();
  poblarFiltroCategoria();
  renderTabla();

  el("estado").textContent = "";
}

// Trae en un solo lote todas las filas de los últimos N días (para todos los fondos a la vez)
// y calcula, por fondo, la serie normalizada (sparkline) y la volatilidad anualizada -> perfil de riesgo.
async function enriquecerConRiesgo(fechaCorte) {
  const desde = new Date(fechaCorte);
  desde.setDate(desde.getDate() - VENTANA_RIESGO_DIAS);
  const desdeIso = desde.toISOString().slice(0, 19) + ".000";

  const url =
    `${SODA_BASE}?$where=${enc(`fecha_corte >= '${desdeIso}'`)}` +
    `&$select=fecha_corte,codigo_negocio,tipo_participacion,valor_unidad_operaciones` +
    `&$order=${enc("fecha_corte ASC")}&$limit=200000`;

  const resp = await fetch(url);
  const filas = await resp.json();

  const claveFondo = (f) => `${f.codigo_negocio}::${f.tipo_participacion}`;
  const validas = new Set(FONDOS.map(claveFondo));

  const series = new Map();
  for (const r of filas) {
    const k = `${r.codigo_negocio}::${r.tipo_participacion}`;
    if (!validas.has(k)) continue;
    if (!series.has(k)) series.set(k, []);
    series.get(k).push(Number(r.valor_unidad_operaciones));
  }

  for (const f of FONDOS) {
    const serieCruda = series.get(claveFondo(f));
    const serie = serieCruda ? serieCruda.filter((v) => Number.isFinite(v) && v > 0) : [];
    if (serie.length < 5) {
      f.volAnual = null;
      f.perfil = null;
      f.sparkline = null;
      continue;
    }
    const retornos = [];
    for (let i = 1; i < serie.length; i++) {
      retornos.push(serie[i] / serie[i - 1] - 1);
    }
    const media = retornos.reduce((a, b) => a + b, 0) / retornos.length;
    const varianza = retornos.reduce((a, b) => a + (b - media) ** 2, 0) / retornos.length;
    f.volAnual = Math.sqrt(varianza * 252) * 100;
    f.perfil = perfilDeRiesgo(f.volAnual);
    f.sparkline = serie.map((v) => (v / serie[0] - 1) * 100); // normalizado a % desde el inicio de la ventana
  }
}

function enc(s) {
  return encodeURIComponent(s);
}

function mediana(valores) {
  const orden = [...valores].sort((a, b) => a - b);
  const mid = Math.floor(orden.length / 2);
  return orden.length % 2 ? orden[mid] : (orden[mid - 1] + orden[mid]) / 2;
}

function poblarResumenMercado() {
  const totalAUM = FONDOS.reduce((a, f) => a + f.aum, 0);
  const totalInv = FONDOS.reduce((a, f) => a + f.inversionistas, 0);
  const rentValidas = FONDOS.map((f) => f.rentAnual).filter((v) => Number.isFinite(v));
  const rentProm = mediana(rentValidas);

  const conteoPerfil = { CONSERVADOR: 0, MODERADO: 0, AGRESIVO: 0 };
  for (const f of FONDOS) if (f.perfil) conteoPerfil[f.perfil]++;

  el("resumenMercado").innerHTML = `
    <div class="kpi">
      <div class="kpi-valor">${FONDOS.length}</div>
      <div class="kpi-etiqueta">Fondos activos</div>
    </div>
    <div class="kpi">
      <div class="kpi-valor">${fmtCOP(totalAUM)}</div>
      <div class="kpi-etiqueta">Patrimonio total (AUM)</div>
    </div>
    <div class="kpi">
      <div class="kpi-valor">${fmtNum(totalInv)}</div>
      <div class="kpi-etiqueta">Inversionistas</div>
    </div>
    <div class="kpi">
      <div class="kpi-valor">${fmtPct(rentProm)}</div>
      <div class="kpi-etiqueta">Rentabilidad anual (mediana)</div>
    </div>
    <div class="kpi kpi-perfiles">
      <div class="kpi-etiqueta">Por perfil de riesgo</div>
      <div class="mini-barras">
        <span class="mini-pill riesgo-bajo">${conteoPerfil.CONSERVADOR} conservador</span>
        <span class="mini-pill riesgo-medio">${conteoPerfil.MODERADO} moderado</span>
        <span class="mini-pill riesgo-alto">${conteoPerfil.AGRESIVO} agresivo</span>
      </div>
    </div>
  `;
}

function poblarFiltroCategoria() {
  const categorias = [...new Set(FONDOS.map((f) => f.categoria))].sort();
  const select = el("filtroTipo");
  for (const c of categorias) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = titleCase(c);
    select.appendChild(opt);
  }
}

function titleCase(s) {
  return s
    .toLowerCase()
    .split(" ")
    .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function fondosFiltrados() {
  const q = el("buscar").value.trim().toLowerCase();
  const cat = el("filtroTipo").value;
  const orden = el("ordenar").value;

  let lista = FONDOS.filter((f) => {
    const coincideTexto =
      !q || f.nombre.toLowerCase().includes(q) || f.gestora.toLowerCase().includes(q);
    const coincideCat = !cat || f.categoria === cat;
    const coincidePerfil = !FILTRO_PERFIL || f.perfil === FILTRO_PERFIL;
    return coincideTexto && coincideCat && coincidePerfil;
  });

  const cmp = {
    aum_desc: (a, b) => b.aum - a.aum,
    rent_desc: (a, b) => (b.rentAnual || -Infinity) - (a.rentAnual || -Infinity),
    rent_asc: (a, b) => (a.rentAnual || Infinity) - (b.rentAnual || Infinity),
    riesgo_asc: (a, b) => (a.volAnual ?? Infinity) - (b.volAnual ?? Infinity),
    nombre: (a, b) => a.nombre.localeCompare(b.nombre),
  }[orden];

  return lista.sort(cmp);
}

function sparklinePath(serie, w, h) {
  const limpia = serie.filter((v) => Number.isFinite(v));
  if (limpia.length < 2) return "";
  const min = Math.min(...limpia);
  const max = Math.max(...limpia);
  const rango = max - min || 1;
  const puntos = limpia.map((v, i) => {
    const x = (i / (limpia.length - 1)) * w;
    const y = h - ((v - min) / rango) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return puntos.join(" ");
}

function renderTabla() {
  const cuerpo = el("cuerpoTabla");
  cuerpo.innerHTML = "";
  const lista = fondosFiltrados();
  el("conteoResultados").textContent = `${lista.length} de ${FONDOS.length} fondos`;

  const frag = document.createDocumentFragment();

  for (const f of lista) {
    const tr = document.createElement("tr");
    const perfil = f.perfil ? PERFIL[f.perfil] : null;
    const puntos = f.sparkline ? sparklinePath(f.sparkline, 100, 28) : "";
    const tendenciaPos = f.sparkline && f.sparkline[f.sparkline.length - 1] >= 0;

    tr.innerHTML = `
      <td class="nombre">
        <div class="nombre-fondo">${f.nombre}</div>
        <div class="nombre-gestora">${f.gestora}</div>
      </td>
      <td><span class="chip">${titleCase(f.categoria)}</span></td>
      <td>${
        perfil
          ? `<span class="chip ${perfil.clase}">${perfil.label}</span>`
          : `<span class="chip chip-neutro">Sin datos</span>`
      }</td>
      <td class="num">${fmtCOP(f.aum)}</td>
      <td class="num">${fmtNum(f.inversionistas)}</td>
      <td class="num ${f.rentAnual >= 0 ? "pos" : "neg"}">${fmtPct(f.rentAnual)}</td>
      <td class="celda-spark">
        ${
          puntos
            ? `<svg viewBox="0 0 100 28" preserveAspectRatio="none" class="spark ${tendenciaPos ? "spark-pos" : "spark-neg"}">
                 <polyline points="${puntos}" fill="none" stroke-width="2" vector-effect="non-scaling-stroke" />
               </svg>`
            : '<span class="sin-dato">—</span>'
        }
      </td>
    `;
    tr.addEventListener("click", () => abrirDetalle(f));
    frag.appendChild(tr);
  }
  cuerpo.appendChild(frag);

  if (lista.length === 0) {
    cuerpo.innerHTML = `<tr><td colspan="7" class="vacio">Sin resultados para ese filtro. Prueba con otro nombre o quita algún filtro.</td></tr>`;
  }
}

async function abrirDetalle(fondo) {
  const panel = el("detalle");
  panel.hidden = false;
  requestAnimationFrame(() => panel.classList.add("detalle-visible"));
  panel.scrollIntoView({ behavior: "smooth", block: "start" });

  el("detalleNombre").textContent = fondo.nombre;
  el("detalleGestora").textContent = fondo.gestora;
  const perfil = fondo.perfil ? PERFIL[fondo.perfil] : null;
  el("detallePerfil").innerHTML = perfil
    ? `<span class="chip ${perfil.clase}">${perfil.label}</span>`
    : "";
  el("detalleCategoria").textContent = titleCase(fondo.categoria);
  el("detalleFicha").href =
    "https://www.google.com/search?q=" +
    encodeURIComponent(`"${fondo.nombre}" ${fondo.gestora} ficha técnica`);

  // Resumen inmediato con lo que ya tenemos (sin esperar el histórico completo)
  renderResumenReportado(fondo);
  el("detalleMetricas").innerHTML = "";
  el("grafico").innerHTML = "";
  el("detalleEstado").textContent = "Cargando histórico completo…";

  try {
    await cargarHistorico(fondo);
  } catch (err) {
    el("detalleEstado").textContent = "Error cargando el histórico: " + err.message;
    console.error(err);
  }
}

function renderResumenReportado(f) {
  const items = [
    ["AUM actual", fmtCOP(f.aum)],
    ["Inversionistas", fmtNum(f.inversionistas)],
    ["Rent. diaria (E.A.)", fmtPct(f.rentDiaria)],
    ["Rent. mensual", fmtPct(f.rentMensual)],
    ["Rent. semestral", fmtPct(f.rentSemestral)],
    ["Rent. anual", fmtPct(f.rentAnual)],
    ["Aportes recibidos (día)", fmtCOP(f.aportes)],
    ["Retiros/redenciones (día)", fmtCOP(f.retiros)],
  ];
  el("detalleReportado").innerHTML = items
    .map(
      ([etiqueta, valor]) => `
      <div class="metrica">
        <div class="valor">${valor}</div>
        <div class="etiqueta">${etiqueta}</div>
      </div>`
    )
    .join("");
}

async function cargarHistorico(fondo) {
  const where = enc(
    `codigo_negocio='${fondo.codigo_negocio}' AND tipo_participacion='${fondo.tipo_participacion}'`
  );
  const url =
    `${SODA_BASE}?$where=${where}` +
    `&$select=fecha_corte,valor_unidad_operaciones&$order=${enc("fecha_corte ASC")}&$limit=5000`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Socrata respondió ${resp.status} al pedir el histórico`);
  const historia = await resp.json();
  if (!Array.isArray(historia) || historia.length === 0) {
    el("detalleEstado").textContent = "Sin histórico disponible para este fondo.";
    return;
  }

  const fechas = historia.map((h) => h.fecha_corte.slice(0, 10));
  const valores = historia.map((h) => Number(h.valor_unidad_operaciones));

  const metricas = calcularMetricas(fechas, valores);
  renderMetricasCalculadas(fondo, metricas);
  renderGrafico(fechas, valores);

  el("detalleEstado").textContent = `${historia.length.toLocaleString("es-CO")} observaciones · ${fechas[0]} a ${fechas[fechas.length - 1]}`;
}

function calcularMetricas(fechas, valores) {
  if (valores.length < 2) return {};

  const retornosDiarios = [];
  for (let i = 1; i < valores.length; i++) {
    if (valores[i - 1] > 0) retornosDiarios.push(valores[i] / valores[i - 1] - 1);
  }

  const media = retornosDiarios.reduce((a, b) => a + b, 0) / retornosDiarios.length;
  const varianza =
    retornosDiarios.reduce((a, b) => a + (b - media) ** 2, 0) / retornosDiarios.length;
  const volAnual = Math.sqrt(varianza * 252) * 100;

  const retornoTotal = (valores[valores.length - 1] / valores[0] - 1) * 100;
  const dias = (new Date(fechas[fechas.length - 1]) - new Date(fechas[0])) / 86400000;
  const anios = dias / 365.25;
  const retornoAnualizado =
    anios > 0 ? ((valores[valores.length - 1] / valores[0]) ** (1 / anios) - 1) * 100 : null;

  let pico = valores[0];
  let maxDD = 0;
  for (const v of valores) {
    if (v > pico) pico = v;
    const dd = (v / pico - 1) * 100;
    if (dd < maxDD) maxDD = dd;
  }

  return { volAnual, retornoTotal, retornoAnualizado, maxDD, nObs: valores.length };
}

function renderMetricasCalculadas(fondo, m) {
  const items = [
    ["Retorno del período", fmtPct(m.retornoTotal)],
    ["Retorno anualizado", fmtPct(m.retornoAnualizado)],
    ["Volatilidad anualizada", fmtPct(m.volAnual)],
    ["Máximo drawdown", fmtPct(m.maxDD)],
  ];
  el("detalleMetricas").innerHTML = items
    .map(
      ([etiqueta, valor]) => `
      <div class="metrica metrica-calculada">
        <div class="valor">${valor}</div>
        <div class="etiqueta">${etiqueta}</div>
      </div>`
    )
    .join("");
}

let vistaGrafico = "valor"; // "valor" | "normalizado"
let ultimaSerie = null;

function renderGrafico(fechas, valores) {
  ultimaSerie = { fechas, valores };
  dibujarGrafico();
}

function dibujarGrafico() {
  if (!ultimaSerie) return;
  const { fechas, valores } = ultimaSerie;
  const y = vistaGrafico === "normalizado" ? valores.map((v) => (v / valores[0] - 1) * 100) : valores;

  Plotly.newPlot(
    "grafico",
    [
      {
        x: fechas,
        y,
        type: "scatter",
        mode: "lines",
        line: { color: "#1c3f5f", width: 1.7 },
        fill: "tozeroy",
        fillcolor: "rgba(28,63,95,0.06)",
        hovertemplate:
          vistaGrafico === "normalizado"
            ? "%{x}<br>%{y:,.1f}%<extra></extra>"
            : "%{x}<br>%{y:,.2f}<extra></extra>",
      },
    ],
    {
      margin: { l: 58, r: 16, t: 10, b: 36 },
      height: 320,
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      font: { color: "#4b5160", size: 12, family: "IBM Plex Sans, sans-serif" },
      xaxis: { gridcolor: "#e4e0d8", showgrid: false, zeroline: false },
      yaxis: {
        title: vistaGrafico === "normalizado" ? "Var. % desde el inicio" : "Valor de la unidad (COP)",
        gridcolor: "#e4e0d8",
        tickformat: vistaGrafico === "normalizado" ? ",.0f" : ",.0f",
        zeroline: vistaGrafico === "normalizado",
        zerolinecolor: "#c9c3b6",
      },
    },
    { responsive: true, displayModeBar: false }
  );
}

// --- listeners ---
el("buscar").addEventListener("input", renderTabla);
el("filtroTipo").addEventListener("change", renderTabla);
el("ordenar").addEventListener("change", renderTabla);
el("cerrarDetalle").addEventListener("click", () => {
  el("detalle").classList.remove("detalle-visible");
  setTimeout(() => (el("detalle").hidden = true), 180);
});

document.querySelectorAll(".pill-perfil").forEach((btn) => {
  btn.addEventListener("click", () => {
    const val = btn.dataset.perfil;
    FILTRO_PERFIL = FILTRO_PERFIL === val ? "" : val;
    document.querySelectorAll(".pill-perfil").forEach((b) => b.classList.toggle("activo", b.dataset.perfil === FILTRO_PERFIL));
    renderTabla();
  });
});

document.querySelectorAll(".toggle-vista button").forEach((btn) => {
  btn.addEventListener("click", () => {
    vistaGrafico = btn.dataset.vista;
    document.querySelectorAll(".toggle-vista button").forEach((b) => b.classList.toggle("activo", b === btn));
    dibujarGrafico();
  });
});

cargarUniverso().catch((err) => {
  el("estado").textContent = "Error cargando datos: " + err.message;
  console.error(err);
});
