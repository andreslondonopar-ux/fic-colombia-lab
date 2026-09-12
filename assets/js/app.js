// FIC Colombia — comparador de Fondos de Inversión Colectiva
// Fuente: Superintendencia Financiera de Colombia, dataset qhpu-8ixx (datos.gov.co / Socrata).
// Sin backend: el API de Socrata expone CORS abierto, así que todo corre en el navegador.

const SODA_BASE = "https://www.datos.gov.co/resource/qhpu-8ixx.json";

const el = (id) => document.getElementById(id);
const fmtCOP = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (n >= 1e12) return "$" + (n / 1e12).toFixed(1) + " billones";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + " mil M";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + " M";
  return "$" + n.toLocaleString("es-CO", { maximumFractionDigits: 0 });
};
const fmtPct = (n, digits = 1) =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : `${n.toFixed(digits)}%`;

let FONDOS = []; // un registro por fondo (la clase de mayor AUM)

async function cargarUniverso() {
  el("estado").textContent = "Consultando el corte más reciente…";

  // 1) fecha de corte más reciente disponible
  const fechaResp = await fetch(`${SODA_BASE}?$select=max(fecha_corte) as m`);
  const fechaJson = await fechaResp.json();
  const fechaCorte = fechaJson[0].m; // ISO completo, ej. 2026-09-08T00:00:00.000

  el("estado").textContent = `Cargando fondos del corte ${fechaCorte.slice(0, 10)}…`;

  // 2) todas las filas (fondo x clase de participación) de ese corte
  const filasResp = await fetch(
    `${SODA_BASE}?$where=fecha_corte='${fechaCorte}'&$limit=3000`
  );
  const filas = await filasResp.json();

  // 3) por cada fondo (codigo_negocio), nos quedamos con la clase de mayor AUM
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
        rentAnual: Number(f.rentabilidad_anual),
        rentMensual: Number(f.rentabilidad_mensual),
      });
    }
  }

  FONDOS = [...porFondo.values()].filter((f) => f.aum > 0);
  el("estado").textContent = `${FONDOS.length} fondos activos, corte ${fechaCorte.slice(0, 10)}. Fuente: Superintendencia Financiera de Colombia.`;

  poblarFiltroCategoria();
  renderTabla();
}

function poblarFiltroCategoria() {
  const categorias = [...new Set(FONDOS.map((f) => f.categoria))].sort();
  const select = el("filtroTipo");
  for (const c of categorias) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    select.appendChild(opt);
  }
}

function fondosFiltrados() {
  const q = el("buscar").value.trim().toLowerCase();
  const cat = el("filtroTipo").value;
  const orden = el("ordenar").value;

  let lista = FONDOS.filter((f) => {
    const coincideTexto =
      !q ||
      f.nombre.toLowerCase().includes(q) ||
      f.gestora.toLowerCase().includes(q);
    const coincideCat = !cat || f.categoria === cat;
    return coincideTexto && coincideCat;
  });

  const cmp = {
    aum_desc: (a, b) => b.aum - a.aum,
    rent_desc: (a, b) => (b.rentAnual || -Infinity) - (a.rentAnual || -Infinity),
    rent_asc: (a, b) => (a.rentAnual || Infinity) - (b.rentAnual || Infinity),
    nombre: (a, b) => a.nombre.localeCompare(b.nombre),
  }[orden];

  return lista.sort(cmp);
}

function renderTabla() {
  const cuerpo = el("cuerpoTabla");
  cuerpo.innerHTML = "";
  const lista = fondosFiltrados();

  for (const f of lista) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="nombre">${f.nombre}</td>
      <td>${f.gestora}</td>
      <td>${f.categoria}</td>
      <td>${fmtCOP(f.aum)}</td>
      <td>${f.inversionistas.toLocaleString("es-CO")}</td>
      <td class="${f.rentAnual >= 0 ? "num-pos" : "num-neg"}">${fmtPct(f.rentAnual)}</td>
      <td class="${f.rentMensual >= 0 ? "num-pos" : "num-neg"}">${fmtPct(f.rentMensual)}</td>
    `;
    tr.addEventListener("click", () => abrirDetalle(f));
    cuerpo.appendChild(tr);
  }

  if (lista.length === 0) {
    cuerpo.innerHTML = `<tr><td colspan="7" style="color:var(--tinta-3)">Sin resultados para ese filtro.</td></tr>`;
  }
}

async function abrirDetalle(fondo) {
  const panel = el("detalle");
  panel.hidden = false;
  panel.scrollIntoView({ behavior: "smooth", block: "start" });

  el("detalleNombre").textContent = fondo.nombre;
  el("detalleGestora").textContent = `${fondo.gestora} · ${fondo.categoria}`;
  el("detalleFicha").href =
    "https://www.google.com/search?q=" +
    encodeURIComponent(`"${fondo.nombre}" ${fondo.gestora} ficha técnica`);
  el("detalleMetricas").innerHTML = "";
  el("grafico").innerHTML = "";
  el("detalleEstado").textContent = "Cargando histórico…";

  try {
    await cargarHistorico(fondo);
  } catch (err) {
    el("detalleEstado").textContent = "Error cargando el histórico: " + err.message;
    console.error(err);
  }
}

async function cargarHistorico(fondo) {
  const where = encodeURIComponent(
    `codigo_negocio='${fondo.codigo_negocio}' AND tipo_participacion='${fondo.tipo_participacion}'`
  );
  const url =
    `${SODA_BASE}?$where=${where}` +
    `&$select=fecha_corte,valor_unidad_operaciones&$order=${encodeURIComponent("fecha_corte ASC")}&$limit=5000`;

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Socrata respondió ${resp.status} al pedir el histórico`);
  }
  const historia = await resp.json();
  if (!Array.isArray(historia) || historia.length === 0) {
    el("detalleEstado").textContent = "Sin histórico disponible para este fondo.";
    return;
  }

  const fechas = historia.map((h) => h.fecha_corte.slice(0, 10));
  const valores = historia.map((h) => Number(h.valor_unidad_operaciones));

  const metricas = calcularMetricas(fechas, valores);
  renderMetricas(fondo, metricas);
  renderGrafico(fechas, valores);

  el("detalleEstado").textContent = `${historia.length} observaciones, ${fechas[0]} a ${fechas[fechas.length - 1]}.`;
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

function renderMetricas(fondo, m) {
  const items = [
    ["AUM actual", fmtCOP(fondo.aum)],
    ["Inversionistas", fondo.inversionistas.toLocaleString("es-CO")],
    ["Retorno del período", fmtPct(m.retornoTotal)],
    ["Retorno anualizado", fmtPct(m.retornoAnualizado)],
    ["Volatilidad anualizada", fmtPct(m.volAnual)],
    ["Máximo drawdown", fmtPct(m.maxDD)],
  ];
  el("detalleMetricas").innerHTML = items
    .map(
      ([etiqueta, valor]) => `
      <div class="metrica">
        <div class="valor">${valor}</div>
        <div class="etiqueta">${etiqueta}</div>
      </div>`
    )
    .join("");
}

function renderGrafico(fechas, valores) {
  const oscuro = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const tinta = oscuro ? "#eef0f3" : "#14181f";
  const grilla = oscuro ? "#2b3038" : "#e2e5eb";

  Plotly.newPlot(
    "grafico",
    [
      {
        x: fechas,
        y: valores,
        type: "scatter",
        mode: "lines",
        line: { color: "#1f6f5c", width: 1.6 },
        hovertemplate: "%{x}<br>Valor unidad: %{y:,.2f}<extra></extra>",
      },
    ],
    {
      margin: { l: 55, r: 20, t: 10, b: 40 },
      height: 340,
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      font: { color: tinta, size: 12 },
      xaxis: { gridcolor: grilla, showgrid: false },
      yaxis: { title: "Valor de la unidad (COP)", gridcolor: grilla, tickformat: ",.0f" },
    },
    { responsive: true, displayModeBar: false }
  );
}

el("buscar").addEventListener("input", renderTabla);
el("filtroTipo").addEventListener("change", renderTabla);
el("ordenar").addEventListener("change", renderTabla);
el("cerrarDetalle").addEventListener("click", () => {
  el("detalle").hidden = true;
});

cargarUniverso().catch((err) => {
  el("estado").textContent = "Error cargando datos: " + err.message;
  console.error(err);
});
