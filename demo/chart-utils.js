export var HORIZONTAL_BAR_AXIS_LABEL_WIDTH = 120;
export var HORIZONTAL_BAR_LABEL_MAX_CHARS = 18;
export var HORIZONTAL_BAR_MIN_HEIGHT = 260;
export var HORIZONTAL_BAR_MAX_HEIGHT = 520;
export var HORIZONTAL_BAR_ROW_HEIGHT = 28;
export var HORIZONTAL_BAR_VERTICAL_PADDING = 44;

export function truncateHorizontalBarLabel(value, maxChars) {
  var text = value == null ? "" : String(value);
  var limit = typeof maxChars === "number" && maxChars > 1 ? Math.floor(maxChars) : HORIZONTAL_BAR_LABEL_MAX_CHARS;

  if (text.length <= limit) {
    return text;
  }

  return text.slice(0, limit - 1) + "\u2026";
}

export function resolveHorizontalBarChartHeight(rowCount) {
  var rows = typeof rowCount === "number" && rowCount > 0 ? Math.ceil(rowCount) : 1;
  var preferredHeight = HORIZONTAL_BAR_VERTICAL_PADDING + rows * HORIZONTAL_BAR_ROW_HEIGHT;

  return Math.max(
    HORIZONTAL_BAR_MIN_HEIGHT,
    Math.min(HORIZONTAL_BAR_MAX_HEIGHT, preferredHeight)
  );
}
