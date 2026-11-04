function curve(a, b, c, d, steps = 8) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    points.push([
      u ** 3 * a[0] + 3 * u ** 2 * t * b[0] + 3 * u * t ** 2 * c[0] + t ** 3 * d[0],
      u ** 3 * a[1] + 3 * u ** 2 * t * b[1] + 3 * u * t ** 2 * c[1] + t ** 3 * d[1]
    ]);
  }
  return points;
}
function stretch(kind, width, height, reversed = false) {
  let lines;
  if (kind === "arrow") {
    const head = Math.min(height, width / 2);
    lines = [
      [[0, height / 2], [width, height / 2]],
      [[width - head, 0], [width, height / 2], [width - head, height]]
    ];
  } else if (kind === "brace") {
    const cap = Math.min(width / 4, height * 0.8);
    const mid = width / 2;
    const half = height / 2;
    lines = [[
      ...curve([0, height], [0, half], [cap / 2, half], [cap, half]),
      [mid - cap, half],
      ...curve([mid - cap, half], [mid - cap / 2, half], [mid, half], [mid, 0]).slice(1),
      ...curve([mid, 0], [mid, half], [mid + cap / 2, half], [mid + cap, half]).slice(1),
      [width - cap, half],
      ...curve([width - cap, half], [width - cap / 2, half], [width, half], [width, height]).slice(1)
    ]];
  } else {
    lines = [curve([0, height], [0, -height / 3], [width, -height / 3], [width, height], 32)];
  }
  if (!reversed) return lines;
  return lines.map((line) => line.map(([x, y]) => kind === "arrow" ? [width - x, y] : [x, height - y]));
}
export {
  stretch
};
