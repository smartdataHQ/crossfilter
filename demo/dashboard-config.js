// demo/dashboard-config.js
// Test fixture config for the bluecar_stays cube.
// Exercises all component types the engine must support.

export var BLUECAR_STAYS_CONFIG = {
  cube: 'bluecar_stays',
  partition: 'bluecar.is',
  title: 'Iceland Rental Car Stays',

  panels: [
    // KPIs
    { measure: 'count', label: 'Total Stays', chart: 'kpi', section: 'kpis' },
    { measure: 'unique_bookings', label: 'Bookings', chart: 'kpi', section: 'kpis' },
    { measure: 'unique_cars', label: 'Vehicles', chart: 'kpi', section: 'kpis' },
    { measure: 'poi_match_rate', label: 'POI Match Rate', chart: 'kpi', section: 'kpis' },

    // Time series
    { dimension: 'stay_started_at', chart: 'line', granularity: 'day', section: 'timeline', width: 'full' },

    // Categorical charts
    { dimension: 'activity_type', section: 'overview' },
    { dimension: 'car_class', limit: 12, section: 'overview' },
    { dimension: 'region', section: 'overview' },

    // Vehicle details
    { dimension: 'vehicle_make', section: 'vehicles' },
    { dimension: 'fuel_type', chart: 'pie', section: 'vehicles' },
    { dimension: 'drive_type', chart: 'pie', section: 'vehicles' },

    // Geography (searchable lists)
    { dimension: 'municipality', chart: 'list', section: 'geography' },
    { dimension: 'locality', chart: 'list', section: 'geography' },
    { dimension: 'poi_name', chart: 'list', section: 'geography' },
    { dimension: 'poi_category', section: 'geography' },

    // Inline filters — rendered inside the model bar
    { dimension: 'has_poi_match', chart: 'toggle', section: 'modelbar' },
    { dimension: 'is_first_stay', chart: 'toggle', section: 'modelbar' },
    { dimension: 'stay_duration_hours', chart: 'range', section: 'modelbar' },

    // Data table
    { chart: 'table', section: 'details', width: 'full',
      columns: ['car_class', 'region', 'activity_type', 'poi_name', 'stay_duration_hours', 'stay_started_at'] },
  ],

  layout: {
    sections: [
      { id: 'kpis', columns: 4 },
      { id: 'timeline', columns: 1 },
      { id: 'overview', label: 'Overview', columns: 3 },
      { id: 'vehicles', label: 'Vehicles', columns: 3 },
      { id: 'geography', label: 'Geography', columns: 2, collapsed: true },
      { id: 'modelbar', location: 'modelbar' },
      { id: 'details', label: 'Details', columns: 1 },
    ],
  },
};
