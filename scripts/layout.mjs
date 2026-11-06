// Layered graph layout shared by the terminal and page renderers. Both ask for the same thing
// (ranks of boxes with edges routed between neighbouring ranks) and only differ in units.

const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

/** Edges that close a cycle, found by depth-first search. They are laid out reversed. */
function findBackEdges(ids, edges) {
  const outgoing = new Map(ids.map((id) => [id, []]));
  edges.forEach((edge, index) => outgoing.get(edge.from).push({ to: edge.to, index }));
  const hasIncoming = new Set(edges.map((edge) => edge.to));
  const roots = [...ids.filter((id) => !hasIncoming.has(id)), ...ids];

  const state = new Map();
  const back = new Set();
  const visit = (id) => {
    state.set(id, 'open');
    for (const { to, index } of outgoing.get(id)) {
      if (state.get(to) === 'open') back.add(index);
      else if (!state.has(to)) visit(to);
    }
    state.set(id, 'done');
  };
  for (const id of roots) if (!state.has(id)) visit(id);
  return back;
}

function assignRanks(ids, dag) {
  const rank = new Map(ids.map((id) => [id, 0]));
  const pending = new Map(ids.map((id) => [id, 0]));
  dag.forEach(({ to }) => pending.set(to, pending.get(to) + 1));
  const queue = ids.filter((id) => pending.get(id) === 0);
  while (queue.length) {
    const id = queue.shift();
    for (const edge of dag) {
      if (edge.from !== id) continue;
      rank.set(edge.to, Math.max(rank.get(edge.to), rank.get(id) + 1));
      pending.set(edge.to, pending.get(edge.to) - 1);
      if (pending.get(edge.to) === 0) queue.push(edge.to);
    }
  }
  // A source with a distant child sits right above it, so its edge stays short.
  for (const id of ids) {
    if (dag.some((edge) => edge.to === id)) continue;
    const children = dag.filter((edge) => edge.from === id).map((edge) => rank.get(edge.to));
    if (children.length) rank.set(id, Math.min(...children) - 1);
  }
  return rank;
}

function countCrossings(ranks, segments) {
  let crossings = 0;
  const position = new Map();
  ranks.forEach((rank) => rank.forEach((v, i) => position.set(v, i)));
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const a = segments[i];
      const b = segments[j];
      if (a.from.rank !== b.from.rank) continue;
      const top = position.get(a.from) - position.get(b.from);
      const bottom = position.get(a.to) - position.get(b.to);
      if (top * bottom < 0) crossings += 1;
    }
  }
  return crossings;
}

function orderRanks(ranks, segments) {
  const sortBy = (rank, neighbours) => {
    const position = new Map();
    ranks.forEach((r) => r.forEach((v, i) => position.set(v, i)));
    const score = new Map(rank.map((v, i) => {
      const list = neighbours(v);
      return [v, list.length ? list.reduce((sum, n) => sum + position.get(n), 0) / list.length : i];
    }));
    rank.sort((a, b) => score.get(a) - score.get(b));
  };
  const above = (v) => segments.filter((s) => s.to === v).map((s) => s.from);
  const below = (v) => segments.filter((s) => s.from === v).map((s) => s.to);

  let best = ranks.map((rank) => [...rank]);
  let bestCount = countCrossings(ranks, segments);
  for (let pass = 0; pass < 8 && bestCount > 0; pass += 1) {
    if (pass % 2 === 0) for (let r = 1; r < ranks.length; r += 1) sortBy(ranks[r], above);
    else for (let r = ranks.length - 2; r >= 0; r -= 1) sortBy(ranks[r], below);
    const count = countCrossings(ranks, segments);
    if (count < bestCount) {
      bestCount = count;
      best = ranks.map((rank) => [...rank]);
    }
  }
  return best;
}

/**
 * Moves a rank as close as it can to where its neighbours want it, keeping order and spacing.
 * Removing the spacing turns this into isotonic regression, solved by pooling adjacent values.
 */
function placeRank(rank, desired, gap) {
  const offsets = [];
  let offset = 0;
  rank.forEach((v, i) => {
    if (i > 0) offset += (rank[i - 1].w + v.w) / 2 + gap;
    offsets.push(offset);
  });
  const blocks = [];
  rank.forEach((v, i) => {
    blocks.push({ sum: desired[i] - offsets[i], size: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      if (prev.sum / prev.size <= last.sum / last.size) break;
      prev.sum += last.sum;
      prev.size += last.size;
      blocks.pop();
    }
  });
  let i = 0;
  for (const block of blocks) {
    for (let k = 0; k < block.size; k += 1, i += 1) rank[i].x = block.sum / block.size + offsets[i];
  }
}

function assignX(ranks, segments, gap) {
  for (const rank of ranks) placeRank(rank, rank.map(() => 0), gap);
  const widest = Math.max(...ranks.map((rank) => rank[rank.length - 1].x - rank[0].x + (rank[0].w + rank[rank.length - 1].w) / 2));
  for (const rank of ranks) {
    const span = rank[rank.length - 1].x - rank[0].x;
    rank.forEach((v) => { v.x += (widest - span) / 2; });
  }
  const mean = (list, fallback) => (list.length ? list.reduce((sum, v) => sum + v.x, 0) / list.length : fallback);
  for (let pass = 0; pass < 16; pass += 1) {
    const down = pass % 2 === 0;
    const order = down ? ranks : [...ranks].reverse();
    for (const rank of order) {
      const desired = rank.map((v) => mean(
        segments.filter((s) => (down ? s.to === v : s.from === v)).map((s) => (down ? s.from : s.to)),
        v.x,
      ));
      placeRank(rank, desired, gap);
    }
  }
}

/** Gives each segment end a point on its box, spreading several edges along the side. */
function assignPorts(vertices, segments, inset, snap) {
  const round = snap ? Math.round : (value) => value;
  const range = (v) => [v.x - v.w / 2 + inset, v.x + v.w / 2 - inset];
  const spread = (v, list, key, otherX) => {
    const [low, high] = range(v);
    const sorted = [...list].sort((a, b) => otherX(a) - otherX(b));
    sorted.forEach((segment, i) => {
      const t = sorted.length === 1 ? 0.5 : i / (sorted.length - 1);
      segment[key] = round(v.dummy ? v.x : low + (high - low) * t);
    });
  };
  for (const v of vertices) {
    const out = segments.filter((s) => s.from === v);
    if (out.length === 1) out[0].x1 = round(v.dummy ? v.x : clamp(out[0].to.x, ...range(v)));
    else spread(v, out, 'x1', (s) => s.to.x);
  }
  for (const v of vertices) {
    const incoming = segments.filter((s) => s.to === v);
    if (incoming.length === 1) incoming[0].x2 = round(v.dummy ? v.x : clamp(incoming[0].x1, ...range(v)));
    else spread(v, incoming, 'x2', (s) => s.x1);
  }
  // A lone port aims straight at its partner where the partner's box allows it.
  for (const segment of segments) {
    if (segment.x1 === segment.x2 || segment.from.dummy) continue;
    if (segments.filter((s) => s.from === segment.from).length !== 1) continue;
    segment.x1 = round(clamp(segment.x2, ...range(segment.from)));
  }
}

/**
 * Lays out a directed graph top to bottom.
 * `sizeOf(node)` gives {w, h}. Returns ranks of vertices, segments between neighbouring ranks,
 * chains (one per edge, in layout order) and self-loops, which the renderers list separately.
 */
export function layoutGraph(nodes, edges, { sizeOf, gapX, dummyWidth, inset, snap = false }) {
  const ids = nodes.map((node) => node.id);
  const selfLoops = edges.filter((edge) => edge.from === edge.to);
  const links = edges.filter((edge) => edge.from !== edge.to);
  const back = findBackEdges(ids, links);
  const dag = links.map((edge, index) => (back.has(index) ? { from: edge.to, to: edge.from } : { from: edge.from, to: edge.to }));
  const rankOf = assignRanks(ids, dag);

  const lowest = Math.min(...rankOf.values());
  const highest = Math.max(...rankOf.values());
  const ranks = Array.from({ length: highest - lowest + 1 }, () => []);
  const vertex = new Map();
  for (const node of nodes) {
    const rank = rankOf.get(node.id) - lowest;
    const v = { id: node.id, node, rank, dummy: false, x: 0, ...sizeOf(node) };
    vertex.set(node.id, v);
    ranks[rank].push(v);
  }

  const segments = [];
  const chains = links.map((edge, index) => {
    const reversed = back.has(index);
    const start = vertex.get(reversed ? edge.to : edge.from);
    const end = vertex.get(reversed ? edge.from : edge.to);
    const chain = { edge, reversed, segments: [] };
    let previous = start;
    for (let rank = start.rank + 1; rank <= end.rank; rank += 1) {
      let next = end;
      if (rank < end.rank) {
        next = { id: `~${index}.${rank}`, rank, dummy: true, x: 0, w: dummyWidth, h: 0 };
        ranks[rank].push(next);
      }
      const segment = { from: previous, to: next, chain };
      segments.push(segment);
      chain.segments.push(segment);
      previous = next;
    }
    return chain;
  });

  const ordered = orderRanks(ranks, segments);
  assignX(ordered, segments, gapX);

  const vertices = ordered.flat();
  const left = Math.min(...vertices.map((v) => v.x - v.w / 2));
  for (const v of vertices) v.x -= left;
  if (snap) {
    // Whole characters only. Rounding can eat a gap, so restore spacing left to right.
    for (const rank of ordered) {
      let edge = -Infinity;
      for (const v of rank) {
        const leftEdge = Math.max(Math.round(v.x - v.w / 2), edge);
        v.x = leftEdge + (v.w - 1) / 2;
        edge = leftEdge + v.w + gapX;
      }
    }
  }
  assignPorts(vertices, segments, inset, snap);
  const width = Math.max(...vertices.map((v) => v.x + v.w / 2));
  return { ranks: ordered, segments, chains, selfLoops, width };
}
