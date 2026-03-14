export function parseDemoPreferences(rawValue) {
  if (!rawValue) {
    return {};
  }

  try {
    var parsed = JSON.parse(rawValue);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

export function serializeDemoPreferences(preferences) {
  return JSON.stringify(preferences || {});
}

export function resolvePreferredDataSource(preferredSource, liveApiAvailable) {
  if (preferredSource === "file") {
    return "file";
  }

  if (preferredSource === "live") {
    return liveApiAvailable ? "live" : "file";
  }

  return liveApiAvailable ? "live" : "file";
}

export function sanitizeStoredDataSource(value) {
  return value === "live" || value === "file" ? value : null;
}

export function sanitizeStoredGranularity(value, allowedValues) {
  return Array.isArray(allowedValues) && allowedValues.includes(value) ? value : null;
}

export function isLiveApiProbeStatusAvailable(status) {
  return (status >= 200 && status < 300) || status === 401 || status === 403;
}

export function shouldFallbackToLocalFromLiveErrorMessage(message) {
  var text = String(message || "").toLowerCase();

  return (
    text.includes("unsupported method ('post')") ||
    text.includes("unsupported method (&#x27;post&#x27;)") ||
    text.includes(" 501 ") ||
    text.includes(" 405 ") ||
    text.includes(" 404 ") ||
    text.includes("not found") ||
    text.includes("method not allowed")
  );
}
