var DEMO_THEME_NAME = 'crossfilter-demo-v7';
var registered = false;

export function registerDemoEChartsTheme(echarts) {
  if (!echarts || registered || typeof echarts.registerTheme !== 'function') {
    return DEMO_THEME_NAME;
  }

  echarts.registerTheme(DEMO_THEME_NAME, {
    backgroundColor: 'transparent',
    textStyle: {
      fontFamily: "Lato, Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
      color: '#3f6587',
    },
    title: {
      textStyle: {
        color: '#000e4a',
        fontFamily: "Lato, Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        fontSize: 14,
        fontWeight: 700,
      },
      subtextStyle: {
        color: '#3f6587',
        fontFamily: "Lato, Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        fontSize: 11,
      },
    },
    legend: {
      textStyle: {
        color: '#3f6587',
        fontFamily: "Lato, Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
      },
    },
    tooltip: {
      backgroundColor: 'rgba(255,255,255,0.95)',
      borderColor: 'rgba(63,101,135,0.15)',
      textStyle: {
        color: '#000e4a',
        fontFamily: "Lato, Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        fontSize: 12,
      },
      extraCssText: 'box-shadow: 0 2px 12px rgba(0,21,88,0.08); backdrop-filter: blur(8px); border-radius: 8px;',
    },
    color: ['#00c978', '#3d8bfd', '#f5a623', '#ef4565', '#9b59b6', '#00a8c6'],
    categoryAxis: {
      axisLine: { lineStyle: { color: 'rgba(63,101,135,0.12)' } },
      axisTick: { show: false },
      axisLabel: { color: '#3f6587', fontSize: 11 },
      splitLine: { lineStyle: { color: 'rgba(63,101,135,0.06)' } },
      splitArea: { show: false },
    },
    valueAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: '#3f6587', fontSize: 11 },
      splitLine: { lineStyle: { color: 'rgba(63,101,135,0.06)' } },
      splitArea: { show: false },
    },
    grid: {
      left: 24,
      right: 20,
      top: 20,
      bottom: 24,
      containLabel: false,
    },
  });

  registered = true;
  return DEMO_THEME_NAME;
}

export function getDemoEChartsThemeName() {
  return DEMO_THEME_NAME;
}
