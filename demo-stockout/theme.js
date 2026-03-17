// demo-stockout/theme.js
export var THEME_NAME = 'stockout-dark';

export function registerTheme(echarts) {
  echarts.registerTheme(THEME_NAME, {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: "'JetBrains Mono', monospace", color: '#7a8a9e' },
    title: { textStyle: { color: '#e8edf3' } },
    legend: { textStyle: { color: '#7a8a9e' } },
    tooltip: {
      backgroundColor: '#1a2332',
      borderColor: '#2a3a4e',
      textStyle: { color: '#e8edf3', fontFamily: "'JetBrains Mono', monospace", fontSize: 11 },
    },
    categoryAxis: {
      axisLine: { lineStyle: { color: '#1e2a3a' } },
      axisTick: { show: false },
      axisLabel: { color: '#7a8a9e', fontSize: 10 },
      splitLine: { lineStyle: { color: '#1e2a3a' } },
    },
    valueAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: '#7a8a9e', fontSize: 10 },
      splitLine: { lineStyle: { color: '#1e2a3a' } },
    },
    color: ['#00e68a', '#4da6ff', '#ffb84d', '#ff4d6a', '#b366ff', '#00b8d4'],
  });
}
