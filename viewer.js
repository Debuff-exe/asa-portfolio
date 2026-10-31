// Something Canvas viewer: renders a canvas JSON document into a page.
// Standalone, no dependencies. It reads the editor's format but shares no code with it.
//
//   import { mount } from "./viewer.js";
//   mount(document.getElementById("site"), { src: "pages.json", frame: "Home", previews: "pages.previews.json" });
//
// Images, videos and embeds load by their size on screen (see "Media detail by zoom" below).
// `previews` is the manifest written by tools/previews.mjs; without it media loads full size.
//
// Not supported yet: states, scenes, interactions, sketch style (drawn clean), arrow bindings
// (lines use their saved points), label gaps in lines.

const SVGNS = "http://www.w3.org/2000/svg";

/**
 * Load a document and render it into `container`.
 * Options: `src` (JSON url), or `doc` (an already parsed document) with an optional `base` url
 * for its assets; `frame` (a node name or id) renders only that node, framed on screen;
 * `previews` (manifest url) lets media start small and load full files only when zoomed in.
 */
export async function mount(container, opts = {}) {
  let doc = opts.doc;
  let base = opts.base ?? document.baseURI;
  const t0 = performance.now();
  const previews = opts.previews ? loadPreviews(opts.previews) : null;
  if (!doc) {
    base = new URL(opts.src, document.baseURI).href;
    const res = await fetch(base);
    if (!res.ok) throw new Error(`Couldn't load ${opts.src} (${res.status})`);
    doc = await res.json();
  }
  const t1 = performance.now();
  const viewer = new Viewer(container, doc, { ...opts, base, previews: await previews });
  viewer.stats = { loadMs: t1 - t0, buildMs: performance.now() - t1 };
  return viewer;
}

/** The preview manifest, keyed by each asset's absolute url. Missing or broken → null. */
async function loadPreviews(src) {
  try {
    const url = new URL(src, document.baseURI).href;
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const { items } = await res.json();
    // Asset keys are relative to the document, which sits next to the manifest.
    const out = new Map();
    for (const [key, e] of Object.entries(items ?? {})) out.set(new URL(key, url).href, { ...e, preview: new URL(e.preview, url).href });
    return out;
  } catch (err) {
    console.warn(`[viewer] no previews (${err.message}), media loads full size`);
    return null;
  }
}

export class Viewer {
  constructor(container, doc, opts = {}) {
    this.root = container;
    this.doc = doc;
    this.resolve = (u) => (u ? new URL(u, opts.base ?? document.baseURI).href : u);
    this.camera = { x: 0, y: 0, zoom: 1 };
    this.minZoom = doc.zoomBounds?.min ?? 0.05;
    this.maxZoom = doc.zoomBounds?.max ?? 32;
    this.zoomGated = [];
    this.touched = false;
    this.previews = opts.previews ?? null;
    this.media = [];

    container.classList.add("cvv-root");
    container.style.backgroundColor = doc.meta?.background ?? "#ffffff";
    this.world = el("div", "cvv-world");
    container.replaceChildren(this.world);

    loadFonts(doc.fonts ?? []);

    // Render one node (at its world position) or the whole document.
    const only = opts.frame ? findNode(doc.children, opts.frame) : null;
    if (opts.frame && !only) console.warn(`[viewer] no node named "${opts.frame}", showing everything`);
    if (only) {
      const node = { ...only.node, x: only.origin[0] + only.node.x, y: only.origin[1] + only.node.y };
      this.world.appendChild(this.build(node, 0, 0, false));
      this.focus = node;
    } else {
      this.world.append(...doc.children.map((n) => this.build(n, 0, 0, false)));
      this.focus = null;
    }

    this.initialView();
    attachPanZoom(this);
    // Keep the start view framed while the window resizes, until the visitor moves it.
    new ResizeObserver(() => (this.touched ? this.scheduleMedia() : this.initialView())).observe(container);
  }

  // ---------- Camera ----------

  setCamera(view) {
    Object.assign(this.camera, view);
    this.camera.zoom = clamp(this.camera.zoom, this.minZoom, this.maxZoom);
    const { x, y, zoom } = this.camera;
    // No will-change: transform here. Caching the world as one bitmap while it moves keeps the
    // bitmap at the zoom the gesture started at, and zooming out of a big canvas on a large
    // Retina screen then runs past the GPU tile budget: tiles drop and show the background.
    // Letting the browser redraw at each zoom keeps memory screen-sized and was smooth in practice.
    this.world.style.transform = `translate(${-x * zoom}px, ${-y * zoom}px) scale(${zoom})`;
    for (const [node, e] of this.zoomGated) {
      const vz = node.visibleZoom;
      e.classList.toggle("cvv-zoom-hidden", (vz.min !== undefined && zoom < vz.min) || (vz.max !== undefined && zoom > vz.max));
    }
    this.scheduleMedia();
  }

  panBy(dx, dy) {
    this.setCamera({ x: this.camera.x - dx / this.camera.zoom, y: this.camera.y - dy / this.camera.zoom });
  }

  /** Zoom keeping the screen point (sx, sy) fixed. */
  zoomAt(sx, sy, next) {
    const z = clamp(next, this.minZoom, this.maxZoom);
    const { x, y, zoom } = this.camera;
    this.setCamera({ x: sx / zoom + x - sx / z, y: sy / zoom + y - sy / z, zoom: z });
  }

  /** Fit a world rect into the viewport with screen padding (never above 100%). */
  fit(rect, padding = 40) {
    const vw = this.root.clientWidth, vh = this.root.clientHeight;
    const zoom = clamp(Math.min((vw - padding * 2) / Math.max(rect.w, 1), (vh - padding * 2) / Math.max(rect.h, 1), 1), this.minZoom, this.maxZoom);
    this.setCamera({ zoom, x: rect.x + rect.w / 2 - vw / 2 / zoom, y: rect.y + rect.h / 2 - vh / 2 / zoom });
  }

  initialView() {
    if (this.focus) return this.fit(this.focus);
    const iv = this.doc.initialView;
    if (iv && iv !== "fit" && "frameId" in iv) {
      const n = this.doc.children.find((c) => c.id === iv.frameId);
      if (n) return this.fit(n);
    } else if (iv && iv !== "fit") {
      return this.setCamera(iv);
    }
    const b = unionRects(this.doc.children.filter((n) => !n.hidden));
    if (b) this.fit(b);
  }

  // ---------- Media detail by zoom ----------
  //
  // Each image, video and embed loads only what its size on screen needs: its average color
  // while tiny, the preview while small, the full file once the preview would look soft.
  // Only what's on screen or near it loads. Detail only goes up: a file that has loaded stays.
  // Videos play only while on screen and big enough to watch.

  scheduleMedia() {
    this.mediaFrame ||= requestAnimationFrame(() => {
      this.mediaFrame = 0;
      this.updateMedia();
    });
  }

  updateMedia() {
    const { x, y, zoom } = this.camera;
    const vw = this.root.clientWidth / zoom, vh = this.root.clientHeight / zoom;
    const dpr = window.devicePixelRatio || 1;
    for (const m of this.media) {
      const sw = m.w * zoom, sh = m.h * zoom;
      const overlaps = (k) => m.x < x + vw * (1 + k) && m.x + m.w > x - vw * k && m.y < y + vh * (1 + k) && m.y + m.h > y - vh * k;
      const onScreen = overlaps(0);
      if (onScreen || overlaps(NEAR)) {
        // How much the preview would be stretched to fill the box on this screen.
        const stretch = Math.max((sw * dpr) / m.pw, (sh * dpr) / m.ph);
        const level = Math.max(sw, sh) < TINY ? 0 : stretch > SOFT ? 2 : 1;
        if (level > m.level) showDetail(m, level);
      }
      if (m.kind === "video") playVideo(m, onScreen && Math.min(sw, sh) >= PLAY, this);
    }
  }

  /** Register an image, video or embed for detail-by-zoom. `full` is the full-size image it shows. */
  addMedia(node, kind, mbox, full, wx, wy) {
    const entry = full && this.previews?.get(this.resolve(full));
    const m = {
      node, kind, box: mbox,
      x: wx, y: wy, w: node.w, h: node.h,
      full: full && this.resolve(full),
      preview: entry?.preview ?? null,
      // Without a preview the full file is all there is, so it never looks soft.
      pw: entry?.pw ?? Infinity, ph: entry?.ph ?? Infinity,
      color: entry?.color ?? node.placeholder?.color ?? (kind === "image" ? "#e9ecef" : "#1e1e1e"),
      level: -1, shown: null, img: null, vid: null, resume: false,
    };
    mbox.style.background = m.color;
    this.media.push(m);
    return m;
  }

  // ---------- Nodes ----------  // ---------- Nodes ----------

  /** Build a node's element. (ox, oy) is its parent's world origin; `hidden` if an ancestor is. */
  build(node, ox, oy, hidden) {
    const e = el("div", `cvv-node cvv-${node.type}`);
    e.dataset.id = node.id;
    box(node, e);
    hidden ||= !!node.hidden;
    const paint = PAINTERS[node.type];
    if (paint) paint(node, e, this, ox + node.x, oy + node.y, hidden);
    if (node.visibleZoom) this.zoomGated.push([node, e]);
    if (node.children) {
      const c = el("div", "cvv-children");
      if (node.type === "frame" && node.clip) {
        c.style.overflow = "hidden";
        c.style.borderRadius = radiusCss(node.style.radius, node);
      }
      c.append(...node.children.map((n) => this.build(n, ox + node.x, oy + node.y, hidden)));
      e.appendChild(c);
    }
    return e;
  }
}

/** Position, size, rotation and shared effects (opacity, blend, shadows, blur). */
function box(node, e) {
  const s = e.style;
  s.left = `${node.x}px`;
  s.top = `${node.y}px`;
  s.width = `${Math.max(0, node.w)}px`;
  s.height = `${Math.max(0, node.h)}px`;
  if (node.rotation) s.transform = `rotate(${node.rotation}deg)`;
  if (node.hidden) s.display = "none";
  const style = node.style ?? {};
  if (style.opacity !== undefined && style.opacity !== 1) s.opacity = String(style.opacity);
  if (style.blendMode && style.blendMode !== "normal") s.mixBlendMode = style.blendMode;

  // Box-like shapes get a cheap box-shadow; anything else needs a drop-shadow filter.
  const boxy = BOXES.has(node.type) || (node.type === "rect" && !style.sketch) || (node.type === "ellipse" && !style.sketch);
  const filters = [], shadows = [];
  for (const sh of style.shadows ?? []) {
    if (boxy) shadows.push(`${sh.inset ? "inset " : ""}${sh.x}px ${sh.y}px ${sh.blur}px ${sh.spread}px ${sh.color}`);
    else if (!sh.inset) filters.push(`drop-shadow(${sh.x}px ${sh.y}px ${sh.blur}px ${sh.color})`);
  }
  if (style.blur) filters.push(`blur(${style.blur}px)`);
  if (filters.length) s.filter = filters.join(" ");
  if (shadows.length) {
    s.boxShadow = shadows.join(", ");
    s.borderRadius = node.type === "ellipse" ? "50%" : radiusCss(style.radius, node);
  }
}

const BOXES = new Set(["frame", "image", "video", "embed"]);

const PAINTERS = {
  frame: paintFrame,
  rect: paintShape,
  ellipse: paintShape,
  diamond: paintShape,
  polygon: paintShape,
  line: paintLine,
  arrow: paintLine,
  freedraw: paintFreedraw,
  text: paintText,
  image: paintImage,
  video: paintVideo,
  embed: paintEmbed,
};

function paintFrame(node, e) {
  const svg = svgRoot(node.w, node.h, 0);
  const defs = svg.firstChild;
  svg.appendChild(svgEl("path", { d: rectPath(0, 0, node.w, node.h, node.style.radius), fill: fillPaint(node.style.fill, defs), ...strokeAttrs(node.style.stroke) }));
  e.appendChild(svg);
}

function paintShape(node, e) {
  const { style } = node;
  const sw = style.stroke?.width || 0;
  const svg = svgRoot(node.w, node.h, sw);
  const defs = svg.firstChild;
  svg.appendChild(svgEl("path", { d: shapeOutline(node), fill: fillPaint(style.fill, defs), ...strokeAttrs(style.stroke) }));
  if (style.stroke?.double) svg.appendChild(svgEl("path", { d: shapeOutline(node, sw * 2), fill: "none", ...strokeAttrs(style.stroke) }));
  e.appendChild(svg);
  if (node.label?.html) {
    const label = richText(node.label);
    label.style.inset = `${Math.max(8, sw * 2)}px`;
    e.appendChild(label);
  }
}

function paintLine(node, e) {
  const { style, points } = node;
  const svg = svgRoot(Math.max(1, node.w), Math.max(1, node.h), 0);
  if (points?.length >= 2) {
    svg.appendChild(svgEl("path", { d: linePath(points, node.route), fill: "none", ...strokeAttrs(style.stroke) }));
    const route = routedPoints(points, node.route);
    const size = Math.max(10, style.stroke.width * 5);
    const ends = [
      [route[0], route[1], node.heads?.start],
      [route[route.length - 1], route[route.length - 2], node.heads?.end],
    ];
    for (const [tip, from, kind] of ends) {
      const head = arrowhead(kind, tip, from, size);
      if (head) svg.appendChild(svgEl("path", { d: head.d, fill: head.filled ? style.stroke.color : "none", ...strokeAttrs({ ...style.stroke, dash: "solid" }) }));
    }
  }
  e.appendChild(svg);
  if (node.label?.html && points?.length) {
    const [mx, my] = midpoint(routedPoints(points, node.route));
    const label = richText(node.label);
    Object.assign(label.style, { inset: "auto", left: `${mx}px`, top: `${my}px`, transform: "translate(-50%, -50%)", whiteSpace: "nowrap" });
    e.appendChild(label);
  }
}

function paintFreedraw(node, e) {
  const svg = svgRoot(Math.max(1, node.w), Math.max(1, node.h), 0);
  const stroke = node.style.stroke;
  svg.appendChild(svgEl("path", { d: smoothPath(node.points ?? []), fill: "none", ...strokeAttrs({ ...stroke, width: Math.max(1, stroke.width) * 1.25, cap: "round", join: "round" }) }));
  e.appendChild(svg);
}

function paintText(node, e) {
  const t = richText(node.content);
  if (node.autoHeight) t.style.bottom = "auto";
  if (node.autoWidth) t.style.whiteSpace = "pre";
  e.appendChild(t);
}

function mediaBox(node, e) {
  const b = el("div", "cvv-media");
  b.style.borderRadius = radiusCss(node.style.radius, node);
  const st = node.style.stroke;
  if (st?.width && st.color !== "transparent") b.style.outline = `${st.width}px ${st.dash === "dashed" || st.dash === "dotted" ? st.dash : "solid"} ${st.color}`;
  e.appendChild(b);
  return b;
}

function paintImage(node, e, v, wx, wy, hidden) {
  const b = mediaBox(node, e);
  b.style.background = node.placeholder?.color ?? "#e9ecef";
  if (node.src && !hidden) v.addMedia(node, "image", b, node.src, wx, wy);
}

/** Until it's big enough to play, a video shows its poster (as an image), so nothing streams. */
function paintVideo(node, e, v, wx, wy, hidden) {
  const b = mediaBox(node, e);
  b.style.background = "#000";
  if (node.src && !hidden) v.addMedia(node, "video", b, node.poster || node.src, wx, wy);
}

/** Embeds start as a thumbnail card and become the live iframe on click. */
function paintEmbed(node, e, v, wx, wy, hidden) {
  const b = mediaBox(node, e);
  b.style.background = "#1e1e1e";
  if (!node.url) return;
  const thumb = embedThumbnail(node);
  const card = el("div", "cvv-embed-card");
  if (thumb && !hidden) {
    const m = v.addMedia(node, "embed", b, thumb, wx, wy);
    m.card = card;
    card.style.backgroundColor = m.color;
  }
  card.innerHTML = '<div class="cvv-play"><svg width="20" height="20" viewBox="0 0 20 20"><path d="M6 3l11 7-11 7z" fill="#fff"/></svg></div>';
  if (!thumb) card.appendChild(Object.assign(el("div", "cvv-embed-host"), { textContent: hostOf(node.url) }));
  card.addEventListener("click", () => {
    const f = document.createElement("iframe");
    f.src = embedSrc(v.resolve(node.url));
    f.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
    f.referrerPolicy = "strict-origin-when-cross-origin";
    b.replaceChildren(f);
  }, { once: true });
  b.appendChild(card);
}

// ---------- Media detail ----------

const TINY = 24; // CSS px: below this on screen, the average color is enough
const SOFT = 1.25; // load the full file once the preview would be stretched more than this
const PLAY = 120; // CSS px: the smallest a video plays at
const NEAR = 0.5; // also load what's within half a screen of the view, so panning finds it ready

/** Show a detail level: 0 = color (already the box background), 1 = preview, 2 = full file. */
function showDetail(m, level) {
  m.level = level;
  if (level === 0) return;
  const url = level === 2 || !m.preview ? m.full : m.preview;
  if (!url || url === m.shown) return;
  m.shown = url;
  if (m.kind === "embed") {
    whenLoaded(url, () => m.shown === url && (m.card.style.backgroundImage = `url("${url}")`));
  } else if (!m.img) {
    // First image: show it straight away over the color.
    m.img = document.createElement("img");
    m.img.alt = m.node.alt ?? "";
    m.img.decoding = "async";
    m.img.draggable = false;
    m.img.style.objectFit = m.node.fit ?? "cover";
    m.img.src = url;
    m.box.prepend(m.img);
  } else {
    // Upgrades swap in once decoded, so the preview never blinks out.
    whenLoaded(url, () => m.shown === url && (m.img.src = url));
  }
  if (m.vid && level === 2 && m.full) m.vid.poster = m.full;
}

function whenLoaded(url, fn) {
  const i = new Image();
  i.src = url;
  i.decode().then(fn, fn);
}

/**
 * Create the <video> once it's worth playing, then play or pause it as it comes and goes.
 * `m.want` is whether it should run while visible: autoplay at first, then whatever the
 * visitor last did with its controls.
 */
function playVideo(m, visible, v) {
  m.visible = visible;
  if (visible && !m.vid) {
    const n = m.node;
    const vid = (m.vid = document.createElement("video"));
    if (m.shown) vid.poster = m.shown;
    vid.src = v.resolve(n.src);
    vid.preload = "auto";
    vid.playsInline = true;
    vid.muted = n.muted ?? true;
    vid.loop = n.loop ?? false;
    vid.controls = n.controls ?? true;
    m.want = !!n.autoplay;
    // A pause while it's on screen came from the visitor (ours happen only off screen).
    vid.addEventListener("pause", () => m.visible && !vid.ended && (m.want = false));
    vid.addEventListener("play", () => (m.want = true));
    m.box.appendChild(vid);
  }
  if (!m.vid) return;
  if (visible && m.want && m.vid.paused) m.vid.play().catch(() => {});
  else if (!visible && !m.vid.paused) m.vid.pause();
}

// ---------- Rich text ----------

const V_ALIGN = { top: "flex-start", middle: "center", bottom: "flex-end" };

function richText(rt) {
  const s = rt.style;
  const wrap = el("div", "cvv-text");
  Object.assign(wrap.style, {
    justifyContent: V_ALIGN[s.verticalAlign] ?? "flex-start",
    fontFamily: cssFont(s.fontFamily),
    fontSize: `${s.fontSize}px`,
    fontWeight: String(s.fontWeight),
    color: s.color,
    lineHeight: String(s.lineHeight),
    letterSpacing: `${s.letterSpacing}px`,
    textAlign: s.align,
  });
  const content = el("div", "cvv-text-content");
  content.innerHTML = sanitizeHtml(rt.html);
  wrap.appendChild(content);
  return wrap;
}

const GENERIC_FONTS = new Set(["serif", "sans-serif", "monospace", "cursive", "system-ui"]);
const cssFont = (f) => (GENERIC_FONTS.has(f) ? f : `"${String(f).replace(/"/g, "")}", system-ui, sans-serif`);

// Allowlist sanitizer: unknown tags are unwrapped, unknown attributes dropped.
const ALLOWED_TAGS = new Set(["P", "DIV", "SPAN", "B", "STRONG", "I", "EM", "U", "S", "A", "BR", "UL", "OL", "LI", "CODE", "MARK", "SUB", "SUP", "H1", "H2", "H3"]);
const DROP_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "NOSCRIPT", "SVG", "MATH"]);
const ALLOWED_CSS = new Set(["color", "background-color", "font-family", "font-size", "font-weight", "font-style", "text-decoration", "text-align", "line-height", "letter-spacing"]);

function sanitizeHtml(html) {
  const body = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
  clean(body);
  return body.innerHTML;
}

function clean(parent) {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE || DROP_TAGS.has(child.tagName)) {
      child.remove();
      continue;
    }
    clean(child);
    if (!ALLOWED_TAGS.has(child.tagName)) {
      child.replaceWith(...child.childNodes);
      continue;
    }
    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase();
      if (name === "style") child.setAttribute("style", cleanCss(attr.value));
      else if (!(name === "href" && child.tagName === "A" && /^(https?:|mailto:|#|\/)/i.test(attr.value.trim()))) child.removeAttribute(attr.name);
    }
    if (child.tagName === "A") {
      child.target = "_blank";
      child.rel = "noopener noreferrer";
    }
  }
}

function cleanCss(css) {
  return css.split(";").map((decl) => {
    const i = decl.indexOf(":");
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    return i > 0 && ALLOWED_CSS.has(prop) && !/url\(|expression\(|javascript:/i.test(value) ? `${prop}: ${value}` : "";
  }).filter(Boolean).join("; ");
}

// ---------- Fonts ----------

function loadFonts(fonts) {
  const google = fonts.filter((f) => f.source === "google");
  if (google.length) {
    const families = google.map((f) => {
      const w = f.weights?.length ? `:wght@${[...f.weights].sort((a, b) => a - b).join(";")}` : "";
      return `family=${encodeURIComponent(f.family).replace(/%20/g, "+")}${w}`;
    }).join("&");
    const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: `https://fonts.googleapis.com/css2?${families}&display=swap` });
    document.head.appendChild(link);
  }
  for (const f of fonts) {
    if (f.source === "file" && f.url) document.fonts.add(new FontFace(f.family, `url("${f.url}")`));
  }
  // "bundled" fonts (Excalifont, Virgil, Cascadia) aren't shipped with the viewer yet: they fall back to system fonts.
}

// ---------- Pan & zoom ----------

/**
 * Scrolling pans (Shift scrolls sideways); pinch or Ctrl/Cmd + wheel zooms.
 * Drag pans (after a few pixels, so clicks still reach links and embeds). Two-finger touch pinches.
 */
function attachPanZoom(v) {
  const root = v.root;
  const local = (e) => {
    const r = root.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  root.addEventListener("wheel", (e) => {
    e.preventDefault();
    v.touched = true;
    const [sx, sy] = local(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? root.clientHeight : 1;
    const dx = e.deltaX * unit, dy = e.deltaY * unit;
    // Pinch arrives as ctrl+wheel. Plain scrolling always pans: a mouse wheel can't be told
    // apart from a fast trackpad flick, so guessing turned quick two-finger scrolls into zooms.
    if (e.ctrlKey || e.metaKey) v.zoomAt(sx, sy, v.camera.zoom * Math.exp(-dy * 0.01));
    else if (e.shiftKey && !dx) v.panBy(-dy, 0);
    else v.panBy(-dx, -dy);
  }, { passive: false });

  const pointers = new Map();
  let drag = null, pinch = null;

  root.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(b[0] - a[0], b[1] - a[1]), zoom: v.camera.zoom, mid: mid(a, b) };
      drag = null;
    } else if (e.button === 0 || e.button === 1) {
      drag = { id: e.pointerId, start: local(e), last: local(e), moving: e.button === 1 };
    }
  });

  root.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const m = mid(a, b);
      v.panBy(m[0] - pinch.mid[0], m[1] - pinch.mid[1]);
      v.zoomAt(m[0], m[1], pinch.zoom * (Math.hypot(b[0] - a[0], b[1] - a[1]) / pinch.dist));
      pinch.mid = m;
      v.touched = true;
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.moving && Math.hypot(p[0] - drag.start[0], p[1] - drag.start[1]) > 4) {
      drag.moving = true;
      root.dataset.dragged = "1";
      root.setPointerCapture(e.pointerId);
      root.classList.add("cvv-grabbing");
    }
    if (drag.moving) {
      v.panBy(p[0] - drag.last[0], p[1] - drag.last[1]);
      v.touched = true;
    }
    drag.last = p;
  });

  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag?.id === e.pointerId) {
      // The click event fires right after pointerup; clear the flag once it has passed.
      if (drag.moving) setTimeout(() => delete root.dataset.dragged);
      drag = null;
      root.classList.remove("cvv-grabbing");
    }
  };
  root.addEventListener("pointerup", up);
  root.addEventListener("pointercancel", up);
  // A drag that ended on a link shouldn't also open it.
  root.addEventListener("click", (e) => {
    if (root.dataset.dragged) e.preventDefault();
  }, true);
}

const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

// ---------- SVG paint ----------

function svgRoot(w, h, pad) {
  const svg = svgEl("svg", { width: w + pad * 2, height: h + pad * 2, viewBox: `${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}`, class: "cvv-svg" });
  svg.style.left = svg.style.top = `${-pad}px`;
  svg.appendChild(svgEl("defs"));
  return svg;
}

let defId = 0;

/** SVG paint for a fill: a color, or url(#id) of a gradient/pattern added to `defs`. */
function fillPaint(fill, defs) {
  const color = fill?.color ?? "#000000";
  switch (fill?.kind ?? "none") {
    case "none":
      return "none";
    case "solid":
      return color;
    case "linear": {
      const a = ((fill.angle ?? 90) - 90) * (Math.PI / 180);
      return addDef(defs, gradient(svgEl("linearGradient", { x1: 0.5 - Math.cos(a) / 2, y1: 0.5 - Math.sin(a) / 2, x2: 0.5 + Math.cos(a) / 2, y2: 0.5 + Math.sin(a) / 2 }), fill));
    }
    case "radial":
      return addDef(defs, gradient(svgEl("radialGradient", { cx: 0.5, cy: 0.5, r: 0.5 }), fill));
    default: {
      // Hatch patterns (drawn clean, without the sketchy wobble).
      const gap = Math.max(2, fill.gap ?? 8), weight = fill.weight ?? 1;
      const p = svgEl("pattern", { patternUnits: "userSpaceOnUse", width: gap, height: fill.kind === "zigzag" ? gap * 2 : gap, patternTransform: `rotate(${fill.angle ?? -41})` });
      const line = (x1, y1, x2, y2) => p.appendChild(svgEl("line", { x1, y1, x2, y2, stroke: color, "stroke-width": weight }));
      if (fill.kind === "hachure" || fill.kind === "cross-hatch") line(0, 0, 0, gap);
      if (fill.kind === "cross-hatch") line(0, 0, gap, 0);
      if (fill.kind === "dots") p.appendChild(svgEl("circle", { cx: gap / 2, cy: gap / 2, r: Math.max(0.5, weight), fill: color }));
      if (fill.kind === "zigzag") p.appendChild(svgEl("polyline", { points: `0,0 ${gap},${gap} 0,${gap * 2}`, fill: "none", stroke: color, "stroke-width": weight }));
      return addDef(defs, p);
    }
  }
}

function gradient(g, fill) {
  const stops = fill.stops?.length ? fill.stops : [{ offset: 0, color: fill.color ?? "#ffffff" }, { offset: 1, color: "#000000" }];
  for (const s of stops) g.appendChild(svgEl("stop", { offset: s.offset, "stop-color": s.color }));
  return g;
}

function addDef(defs, node) {
  const id = `cvv-${(++defId).toString(36)}`;
  node.id = id;
  defs.appendChild(node);
  return `url(#${id})`;
}

function strokeAttrs(stroke) {
  if (!stroke?.width || stroke.color === "transparent") return { stroke: "none" };
  const w = stroke.width;
  const dash = Array.isArray(stroke.dash) ? stroke.dash.join(" ") : stroke.dash === "dashed" ? `${w * 4} ${w * 3}` : stroke.dash === "dotted" ? `0 ${w * 2.5}` : undefined;
  return {
    stroke: stroke.color,
    "stroke-width": w,
    "stroke-dasharray": dash,
    "stroke-linecap": stroke.dash === "dotted" ? "round" : stroke.cap,
    "stroke-linejoin": stroke.join,
  };
}

// ---------- Geometry ----------

function shapeOutline(node, inset = 0) {
  const { w, h } = node;
  if (node.type === "rect") return rectPath(inset, inset, w - inset * 2, h - inset * 2, node.style.radius?.map((r) => Math.max(0, r - inset)));
  if (node.type === "ellipse") return ellipsePath(inset, inset, w - inset * 2, h - inset * 2);
  let pts = node.type === "diamond"
    ? [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]
    : node.points?.length >= 3 ? node.points : regularPolygon(node.sides ?? 6, w, h, node.star);
  if (inset) {
    const sx = Math.max(0, (w - inset * 2) / w), sy = Math.max(0, (h - inset * 2) / h);
    pts = pts.map(([x, y]) => [w / 2 + (x - w / 2) * sx, h / 2 + (y - h / 2) * sy]);
  }
  return roundedPolyPath(pts, Math.max(0, (node.style.radius?.[0] ?? 0) - inset));
}

function regularPolygon(sides, w, h, star) {
  const n = Math.max(3, Math.round(sides));
  const steps = star ? n * 2 : n;
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / steps;
    const k = star && i % 2 ? star : 1;
    pts.push([w / 2 + (Math.cos(a) * w * k) / 2, h / 2 + (Math.sin(a) * h * k) / 2]);
  }
  return pts;
}

/** Closed path through `pts` with each corner rounded by up to `radius`. */
function roundedPolyPath(pts, radius) {
  if (radius <= 0 || pts.length < 3) return polyPath(pts, true);
  const n = pts.length;
  const cs = pts.map((p, i) => {
    const prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
    const d1 = Math.hypot(prev[0] - p[0], prev[1] - p[1]) || 1;
    const d2 = Math.hypot(next[0] - p[0], next[1] - p[1]) || 1;
    const r = Math.min(radius, d1 / 2, d2 / 2);
    return {
      a: [p[0] + ((prev[0] - p[0]) / d1) * r, p[1] + ((prev[1] - p[1]) / d1) * r],
      p,
      b: [p[0] + ((next[0] - p[0]) / d2) * r, p[1] + ((next[1] - p[1]) / d2) * r],
    };
  });
  let d = `M${rd(cs[0].b[0])} ${rd(cs[0].b[1])}`;
  for (let i = 1; i <= n; i++) {
    const c = cs[i % n];
    d += ` L${rd(c.a[0])} ${rd(c.a[1])} Q${rd(c.p[0])} ${rd(c.p[1])} ${rd(c.b[0])} ${rd(c.b[1])}`;
  }
  return d + " Z";
}

function polyPath(pts, closed) {
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${rd(x)} ${rd(y)}`).join(" ");
  return closed ? d + " Z" : d;
}

function rectPath(x, y, w, h, radius) {
  const max = Math.min(w, h) / 2;
  const [tl, tr, br, bl] = (radius ?? [0, 0, 0, 0]).map((v) => Math.max(0, Math.min(v, max)));
  return [
    `M${rd(x + tl)} ${rd(y)}`, `H${rd(x + w - tr)}`,
    tr ? `A${rd(tr)} ${rd(tr)} 0 0 1 ${rd(x + w)} ${rd(y + tr)}` : "",
    `V${rd(y + h - br)}`,
    br ? `A${rd(br)} ${rd(br)} 0 0 1 ${rd(x + w - br)} ${rd(y + h)}` : "",
    `H${rd(x + bl)}`,
    bl ? `A${rd(bl)} ${rd(bl)} 0 0 1 ${rd(x)} ${rd(y + h - bl)}` : "",
    `V${rd(y + tl)}`,
    tl ? `A${rd(tl)} ${rd(tl)} 0 0 1 ${rd(x + tl)} ${rd(y)}` : "",
    "Z",
  ].join(" ");
}

function ellipsePath(x, y, w, h) {
  const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry;
  return `M${rd(cx - rx)} ${rd(cy)} A${rd(rx)} ${rd(ry)} 0 1 0 ${rd(cx + rx)} ${rd(cy)} A${rd(rx)} ${rd(ry)} 0 1 0 ${rd(cx - rx)} ${rd(cy)} Z`;
}

/** The polyline actually drawn: elbow routes get corners at the midpoint of the dominant axis. */
function routedPoints(pts, route) {
  if (route !== "elbow" || pts.length < 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [px, py] = pts[i - 1], [x, y] = pts[i];
    if (px !== x && py !== y) {
      if (Math.abs(x - px) >= Math.abs(y - py)) out.push([(px + x) / 2, py], [(px + x) / 2, y]);
      else out.push([px, (py + y) / 2], [x, (py + y) / 2]);
    }
    out.push(pts[i]);
  }
  return out;
}

function linePath(pts, route) {
  if (route !== "curved" || pts.length < 3) return polyPath(routedPoints(pts, route), false);
  // Catmull-Rom through every point, as cubic Béziers.
  let d = `M${rd(pts[0][0])} ${rd(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    d += ` C${rd(p1[0] + (p2[0] - p0[0]) / 6)} ${rd(p1[1] + (p2[1] - p0[1]) / 6)} ${rd(p2[0] - (p3[0] - p1[0]) / 6)} ${rd(p2[1] - (p3[1] - p1[1]) / 6)} ${rd(p2[0])} ${rd(p2[1])}`;
  }
  return d;
}

function arrowhead(kind, tip, from, size) {
  if (!kind || kind === "none" || !tip || !from) return null;
  const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const at = (dist, spread) => [tip[0] - Math.cos(ang + spread) * dist, tip[1] - Math.sin(ang + spread) * dist];
  switch (kind) {
    case "arrow": return { d: polyPath([at(size, 0.45), tip, at(size, -0.45)], false), filled: false };
    case "triangle": return { d: polyPath([tip, at(size, 0.4), at(size, -0.4)], true), filled: true };
    case "diamond": return { d: polyPath([tip, at(size / 2, 0.6), at(size, 0), at(size / 2, -0.6)], true), filled: true };
    case "circle": {
      const c = at(size / 2, 0);
      return { d: ellipsePath(c[0] - size / 2, c[1] - size / 2, size, size), filled: true };
    }
    case "bar": return { d: polyPath([at(size * 0.6, Math.PI / 2), at(size * 0.6, -Math.PI / 2)], false), filled: false };
  }
  return null;
}

function midpoint(pts) {
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  let half = 0;
  for (let i = 1; i < pts.length; i++) half += dist(pts[i - 1], pts[i]);
  half /= 2;
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i]);
    if (half <= seg && seg > 0) {
      const t = half / seg;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    }
    half -= seg;
  }
  return pts[pts.length - 1];
}

/** Smooth curve through points (quadratic segments between midpoints). */
function smoothPath(pts) {
  if (pts.length < 3) return pts.length ? polyPath(pts, false) : "";
  let d = `M${rd(pts[0][0])} ${rd(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    d += ` Q${rd(x0)} ${rd(y0)} ${rd((x0 + x1) / 2)} ${rd((y0 + y1) / 2)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${rd(last[0])} ${rd(last[1])}`;
}

// ---------- Embeds ----------

function parseEmbed(url) {
  try {
    const u = new URL(url, document.baseURI);
    const host = u.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return { provider: "youtube", id: u.pathname.slice(1) };
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      return { provider: "youtube", id: u.searchParams.get("v") ?? u.pathname.match(/\/(embed|shorts|live)\/([^/?]+)/)?.[2] };
    }
    if (host.endsWith("vimeo.com")) return { provider: "vimeo", id: u.pathname.match(/\/(\d+)/)?.[1] };
  } catch {
    /* fall through */
  }
  return { provider: "generic" };
}

function embedSrc(url) {
  const { provider, id } = parseEmbed(url);
  if (provider === "youtube" && id) return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`;
  if (provider === "vimeo" && id) return `https://player.vimeo.com/video/${id}?autoplay=1`;
  return url;
}

function embedThumbnail(node) {
  if (node.thumbnail) return node.thumbnail;
  const { provider, id } = parseEmbed(node.url);
  return provider === "youtube" && id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : undefined;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ---------- Helpers ----------

/** Find a node by id or name anywhere in the tree, with the world offset of its parent. */
function findNode(nodes, key, origin = [0, 0]) {
  for (const n of nodes) {
    if (n.id === key || n.name === key) return { node: n, origin };
    if (n.children) {
      const hit = findNode(n.children, key, [origin[0] + n.x, origin[1] + n.y]);
      if (hit) return hit;
    }
  }
  return null;
}

function unionRects(rects) {
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}

function radiusCss(r, node) {
  return r ? r.map((v) => `${Math.min(v, node.w / 2, node.h / 2)}px`).join(" ") : "0";
}

function el(tag, className) {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

function svgEl(tag, attrs = {}) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) e.setAttribute(k, String(v));
  return e;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rd = (v) => Math.round(v * 100) / 100;
