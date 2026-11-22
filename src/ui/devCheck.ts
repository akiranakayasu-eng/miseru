// 開発用: 画面にあるボタンの文字が、見た目で上下左右の真ん中にあるかを計る（2026-11-20 Akira さんの指示でルール化）。
// 開発サーバー（vite）のときだけ window.miseruCheckCentering() として使える。本番のビルドには入らない。
//
// 計り方: 上の空き = 大文字の上端（文字が小文字だけなら x の高さ）− 枠の内側の上端、下の空き = 枠の内側の下端 − ベースライン。
// ディセンダー（g, y の下）は数えない。何行もある要素と、記号だけ（− ＋ ×）の行は目安にとどめる（画素で測り直す）。左右は中身全体（記号や SVG を含む）の左右の空き。
// diffY = 上の空き − 下の空き（プラスなら文字が下寄り）、diffX = 左の空き − 右の空き（プラスなら右寄り）。
// 枠と塗りの無いボタン（文字だけのリンクなど）は、ボタンの箱そのものを枠として計る。

export interface CenterRow {
  label: string;
  cls: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
  diffY: number;
  diffX: number;
  ok: boolean;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

function firstText(el: Element): Text | null {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    // SVG の中の <text> は数えない（？アイコンなど）
    acceptNode: (n) =>
      (n.textContent ?? '').trim() && !(n.parentElement && n.parentElement.closest('svg')) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  return w.nextNode() as Text | null;
}

export function checkCentering(selector = 'button, label.link, .chip, .tile', tolerance = 0.5): CenterRow[] {
  const ctx = document.createElement('canvas').getContext('2d');
  const rows: CenterRow[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    // 中身の文字が何行にも分かれる要素（カード・tile など）は計らない
    const all = document.createRange();
    all.selectNodeContents(el);
    const tops = new Set(Array.from(all.getClientRects()).filter((r) => r.width > 0 && r.height > 0).map((r) => Math.round(r.top)));
    if (tops.size > 1) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const inner = {
      top: rect.top + parseFloat(cs.borderTopWidth),
      bottom: rect.bottom - parseFloat(cs.borderBottomWidth),
      left: rect.left + parseFloat(cs.borderLeftWidth),
      right: rect.right - parseFloat(cs.borderRightWidth),
    };
    let topInk: number;
    let bottomInk: number;
    const text = firstText(el);
    if (text && ctx) {
      const parent = text.parentElement ?? el;
      const pcs = getComputedStyle(parent);
      ctx.font = `${pcs.fontStyle} ${pcs.fontWeight} ${pcs.fontSize} ${pcs.fontFamily}`;
      const t = text.textContent ?? '';
      const ref = /[A-Z0-9]/.test(t) ? 'H' : 'x';
      const ascent = ctx.measureText(ref).actualBoundingBoxAscent;
      // 目印の要素は入れない（flex の子になってずれるため）。文字の箱の下端から descent を引いてベースラインにする
      const tr = document.createRange();
      tr.selectNodeContents(text);
      const boxes = tr.getClientRects();
      if (boxes.length !== 1) continue; // 何行もある要素は計らない
      const descent = ctx.measureText(t).fontBoundingBoxDescent;
      const baseline = boxes[0].bottom - descent;
      topInk = baseline - ascent;
      bottomInk = baseline;
    } else {
      const svg = el.querySelector('svg');
      if (!svg) continue;
      const s = svg.getBoundingClientRect();
      topInk = s.top;
      bottomInk = s.bottom;
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    const c = range.getBoundingClientRect();
    const top = topInk - inner.top;
    const bottom = inner.bottom - bottomInk;
    const left = c.left - inner.left;
    const right = inner.right - c.right;
    const diffY = top - bottom;
    const diffX = left - right;
    rows.push({
      label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30),
      cls: el.className && typeof el.className === 'string' ? el.className : el.tagName.toLowerCase(),
      top: r1(top),
      bottom: r1(bottom),
      left: r1(left),
      right: r1(right),
      diffY: r1(diffY),
      diffX: r1(diffX),
      ok: Math.abs(r1(diffY)) <= tolerance && Math.abs(r1(diffX)) <= tolerance + 0.5,
    });
  }
  return rows;
}

declare global {
  interface Window {
    miseruCheckCentering?: typeof checkCentering;
  }
}

if (import.meta.env.DEV && typeof window !== 'undefined') window.miseruCheckCentering = checkCentering;
