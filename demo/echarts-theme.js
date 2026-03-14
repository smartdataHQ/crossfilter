var DEMO_THEME_NAME = 'crossfilter-demo-v6';
var registered = false;

export function registerDemoEChartsTheme(echarts) {
  if (!echarts || registered || typeof echarts.registerTheme !== 'function') {
    return DEMO_THEME_NAME;
  }

  echarts.registerTheme(DEMO_THEME_NAME, {
    aria: {
      decal: { show: false },
      enabled: true,
    },
    backgroundColor: 'transparent',
    color: ['#0b7285', '#d96f32', '#507d5c', '#c2963d', '#7c5cff', '#b74f6f', '#2c5d9f'],
    grid: {
      left: 24,
      right: 20,
      top: 20,
      bottom: 24,
      containLabel: false,
    },
    textStyle: {
      color: '#1a2f43',
      fontFamily: 'IBM Plex Sans, sans-serif',
    },
    title: {
      textStyle: {
        color: '#0d2238',
        fontFamily: 'Space Grotesk, sans-serif',
        fontSize: 14,
        fontWeight: 700,
      },
      subtextStyle: {
        color: '#5b7288',
        fontFamily: 'IBM Plex Sans, sans-serif',
        fontSize: 11,
      },
    },
    categoryAxis: {
      axisLine: {
        lineStyle: {
          color: 'rgba(22, 47, 74, 0.18)',
        },
      },
      axisTick: {
        show: false,
      },
      axisLabel: {
        color: '#53687d',
        fontSize: 11,
      },
      splitLine: {
        show: false,
      },
      splitArea: {
        show: false,
      },
    },
    valueAxis: {
      axisLine: {
        show: false,
      },
      axisTick: {
        show: false,
      },
      axisLabel: {
        color: '#53687d',
        fontSize: 11,
      },
      splitLine: {
        lineStyle: {
          color: 'rgba(22, 47, 74, 0.08)',
        },
      },
      splitArea: {
        show: false,
      },
    },
    legend: {
      textStyle: {
        color: '#53687d',
        fontFamily: 'IBM Plex Sans, sans-serif',
      },
    },
    tooltip: {
      backgroundColor: 'rgba(11, 22, 36, 0.92)',
      borderColor: 'rgba(255, 255, 255, 0.08)',
      borderWidth: 1,
      textStyle: {
        color: '#f3eee7',
        fontFamily: 'IBM Plex Sans, sans-serif',
        fontSize: 12,
      },
      extraCssText: 'box-shadow:0 18px 40px rgba(5, 18, 31, 0.26); border-radius:14px; padding:10px 12px;',
    },
  });

  registered = true;
  return DEMO_THEME_NAME;
}

export function getDemoEChartsThemeName() {
  return DEMO_THEME_NAME;
}
