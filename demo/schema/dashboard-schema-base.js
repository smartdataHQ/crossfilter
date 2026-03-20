// demo/schema/dashboard-schema-base.js
//
// Static base schema for dashboard configs. Uses anyOf with chart-type
// discriminator so each panel variant only includes the slot fields
// relevant to its chart type. No null-padded fields.

import { allTypeNames, allSlots } from '../chart-types.js';

// ── Helpers ─────────────────────────────────────────────────────────

function nullable(schema) {
  if (schema['$ref']) {
    return { anyOf: [schema, { type: 'null' }] };
  }
  if (schema.type) {
    return Object.assign({}, schema, { type: [schema.type, 'null'] });
  }
  if (schema.enum) {
    return Object.assign({}, schema, { enum: schema.enum.concat([null]) });
  }
  return schema;
}

function strict(properties, required) {
  return {
    type: 'object',
    properties: properties,
    required: required || Object.keys(properties),
    additionalProperties: false,
  };
}

// ── Group chart types by slot signature ──────────────────────────────

function groupBySlotSignature() {
  var types = allTypeNames();
  var groups = {};

  for (var t = 0; t < types.length; ++t) {
    var typeName = types[t];
    var slots = allSlots(typeName);
    // Include name, accepts, required, and array in the signature
    // so types with different constraints don't merge
    var sigKey = slots.map(function (s) {
      return s.name + ':' + s.accepts + (s.required ? '!' : '?') + (s.array ? '[]' : '');
    }).sort().join(',');

    if (!groups[sigKey]) {
      groups[sigKey] = { chartTypes: [], slots: slots };
    }
    groups[sigKey].chartTypes.push(typeName);
  }

  return Object.values(groups);
}

// ── Build panel anyOf branches ──────────────────────────────────────

function buildPanelBranches(dimRef, measRef, anyRef, cubeRefSchema) {
  var groups = groupBySlotSignature();
  var branches = [];

  for (var g = 0; g < groups.length; ++g) {
    var group = groups[g];
    var props = {};
    var required = [];

    // Chart type — enum of types in this group
    if (group.chartTypes.length === 1) {
      props.chart = { type: 'string', const: group.chartTypes[0] };
    } else {
      props.chart = { type: 'string', enum: group.chartTypes };
    }
    required.push('chart');

    // Shared base fields
    props.cube = nullable(cubeRefSchema);
    props.label = nullable({ type: 'string' });
    props.primary = { type: 'boolean' };
    props.limit = nullable({ type: 'integer' });
    props.searchable = { type: 'boolean' };
    props.width = nullable({ type: 'string', enum: ['auto', 'full'] });
    required.push('cube', 'label', 'primary', 'limit', 'searchable', 'width');

    // Slot-specific fields
    for (var s = 0; s < group.slots.length; ++s) {
      var slot = group.slots[s];
      var fieldRef;
      if (slot.accepts === 'dimension') fieldRef = dimRef;
      else if (slot.accepts === 'measure') fieldRef = measRef;
      else fieldRef = anyRef;

      var slotSchema;
      if (slot.array) {
        slotSchema = { type: 'array', items: fieldRef };
      } else {
        slotSchema = fieldRef;
      }

      if (!slot.required) {
        slotSchema = nullable(slotSchema);
      }

      props[slot.name] = slotSchema;
      required.push(slot.name);
    }

    branches.push(strict(props, required));
  }

  return branches;
}

// ── Schema builder ──────────────────────────────────────────────────

export function buildFullSchema(chartTypeEnum, dimEnum, measEnum, cubeEnum) {
  var defs = {
    dimField: { type: 'string', enum: dimEnum },
    measField: { type: 'string', enum: measEnum },
    cubeRef: { type: 'string', enum: cubeEnum },
  };

  var dimRef = { '$ref': '#/$defs/dimField' };
  var measRef = { '$ref': '#/$defs/measField' };
  var anyRef = { anyOf: [dimRef, measRef] };
  var cubeRefSchema = { '$ref': '#/$defs/cubeRef' };

  // Panel — anyOf with chart-type discriminator
  var panelBranches = buildPanelBranches(dimRef, measRef, anyRef, cubeRefSchema);
  var panelSchema = { anyOf: panelBranches };

  // Section
  var sectionSchema = strict({
    id: { type: 'string' },
    label: nullable({ type: 'string' }),
    location: nullable({ type: 'string', enum: ['main', 'modelbar'] }),
    columns: nullable({ type: 'integer' }),
    collapsed: { type: 'boolean' },
    lazy: { type: 'boolean' },
    panels: { type: 'array', items: panelSchema },
  });

  // Shared filter
  var sharedFilterSchema = strict({
    dimension: anyRef,
    cubes: { type: 'array', items: cubeRefSchema },
  });

  // Root
  return {
    type: 'object',
    properties: {
      title: { type: 'string' },
      cubes: { type: 'array', items: cubeRefSchema },
      sharedFilters: { type: 'array', items: sharedFilterSchema },
      sections: { type: 'array', items: sectionSchema },
    },
    required: ['title', 'cubes', 'sharedFilters', 'sections'],
    additionalProperties: false,
    '$defs': defs,
  };
}
