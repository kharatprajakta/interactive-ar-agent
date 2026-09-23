// Each persona's "room", built from Kenney kits (CC0). Units are metres at the
// characters' scale (they stand ~0.75 tall). The camera looks toward -z; the
// character talks to you from `home` and walks to `work` while thinking or
// researching, and to `idle` spots now and then when the call is quiet.
//
// Prop: { m: 'kit/model', p: [x, y, z], r: yawDegrees, s: scale, id, on }
//   Props are re-centred so p is the bottom-centre. `on: 'id'` stacks a prop
//   on top of another (y becomes an offset above it).
// Spot: { at: [x, z], face: [x, z], anim }

const ROOM = (wall, floor, extra = {}) => ({ type: 'room', wall, floor, ...extra });
const OUTDOOR = (ground, sky, extra = {}) => ({ type: 'outdoor', ground, sky, ...extra });

export const SCENES = {
  kitchen: {
    env: ROOM('#f3e3cf', '#d8c0a0', { trim: '#ff9b6b' }),
    props: [
      { m: 'furniture/kitchenFridgeLarge', p: [-1.15, 0, -0.79] },
      { m: 'furniture/kitchenCabinet', p: [-0.66, 0, -0.775] },
      { m: 'furniture/kitchenStove', p: [-0.23, 0, -0.775], id: 'stove' },
      { m: 'furniture/kitchenSink', p: [0.2, 0, -0.775] },
      { m: 'furniture/kitchenCabinetDrawer', p: [0.63, 0, -0.775], id: 'board' },
      { m: 'furniture/kitchenCabinet', p: [1.06, 0, -0.775], id: 'cab' },
      { m: 'furniture/hoodModern', p: [-0.23, 0.82, -0.86] },
      { m: 'furniture/kitchenCabinetUpper', p: [-0.66, 0.8, -0.89] },
      { m: 'furniture/kitchenCabinetUpperDouble', p: [0.415, 0.8, -0.89] },
      { m: 'furniture/kitchenCabinetUpper', p: [1.06, 0.8, -0.89] },
      { m: 'food/pot-stew', p: [-0.3, 0, -0.8], s: 0.28, on: 'stove' },
      { m: 'food/pan', p: [-0.1, 0, -0.7], s: 0.25, on: 'stove' },
      { m: 'food/cutting-board', p: [0.63, 0, -0.72], s: 0.35, r: 90, on: 'board' },
      { m: 'food/tomato', p: [0.58, 0.02, -0.74], s: 0.35, on: 'board' },
      { m: 'food/onion', p: [0.68, 0.02, -0.7], s: 0.35, on: 'board' },
      { m: 'food/knife-block', p: [1.0, 0, -0.86], s: 0.3, on: 'cab' },
      { m: 'furniture/kitchenCoffeeMachine', p: [1.15, 0, -0.84], on: 'cab' },
      { m: 'furniture/rugRounded', p: [0, 0, -0.1], s: 0.8 },
    ],
    home: [0, 0.05],
    work: { at: [-0.23, -0.36], face: [-0.23, -1], anim: 'interact-right' },
    idle: [
      { at: [-1.15, -0.4], face: [-1.15, -1], anim: 'interact-left' },
      { at: [0.63, -0.36], face: [0.63, -1], anim: 'interact-right' },
    ],
  },

  desk: {
    env: ROOM('#dbe6f4', '#c49f78', { trim: '#3fb6ff' }),
    props: [
      { m: 'furniture/desk', p: [0.45, 0, -0.75], id: 'desk' },
      { m: 'furniture/computerScreen', p: [0.45, 0, -0.86], on: 'desk' },
      { m: 'furniture/computerKeyboard', p: [0.45, 0, -0.68], on: 'desk' },
      { m: 'furniture/computerMouse', p: [0.7, 0, -0.68], on: 'desk' },
      { m: 'furniture/lampSquareTable', p: [0.16, 0, -0.86], on: 'desk' },
      { m: 'furniture/chairDesk', p: [1.05, 0, -0.35], r: -140 },
      { m: 'furniture/bookcaseClosed', p: [-0.5, 0, -0.85], id: 'shelf' },
      { m: 'furniture/pottedPlant', p: [-0.95, 0, -0.8] },
      { m: 'furniture/speaker', p: [-1.3, 0, -0.8] },
      { m: 'furniture/rugRound', p: [0, 0, -0.1] },
    ],
    home: [0, 0.05],
    work: { at: [0.45, -0.4], face: [0.45, -1], anim: 'interact-right' },
    idle: [{ at: [-0.5, -0.45], face: [-0.5, -1], anim: 'interact-left' }],
  },

  office: {
    env: ROOM('#d6cbb6', '#8a6b4f', { trim: '#5b7cff' }),
    props: [
      { m: 'furniture/desk', p: [-0.45, 0, -0.75], id: 'desk' },
      { m: 'furniture/laptop', p: [-0.45, 0, -0.78], on: 'desk' },
      { m: 'furniture/lampRoundTable', p: [-0.73, 0, -0.84], on: 'desk' },
      { m: 'furniture/radio', p: [-0.18, 0, -0.86], on: 'desk' },
      { m: 'furniture/bookcaseOpen', p: [0.45, 0, -0.85] },
      { m: 'furniture/books', p: [0.4, 0.43, -0.85] },
      { m: 'furniture/bookcaseOpen', p: [0.87, 0, -0.85] },
      { m: 'furniture/books', p: [0.9, 0.16, -0.85] },
      { m: 'furniture/coatRackStanding', p: [1.3, 0, -0.7] },
      { m: 'furniture/cardboardBoxClosed', p: [-1.1, 0, -0.8], id: 'box' },
      { m: 'furniture/cardboardBoxOpen', p: [-1.1, 0, -0.8], s: 0.8, r: 15, on: 'box' },
      { m: 'furniture/rugRectangle', p: [0, 0, -0.15], s: 0.9 },
    ],
    home: [0, 0.05],
    work: { at: [-0.45, -0.4], face: [-0.45, -1], anim: 'interact-right' },
    idle: [
      { at: [0.45, -0.45], face: [0.45, -1], anim: 'interact-right' },
      { at: [-1.1, -0.42], face: [-1.1, -1], anim: 'interact-left' },
    ],
  },

  lounge: {
    env: ROOM('#ece0cf', '#b4967a', { trim: '#2bb673' }),
    props: [
      { m: 'furniture/loungeSofa', p: [0, 0, -0.8] },
      { m: 'furniture/pottedPlant', p: [-0.72, 0, -0.85] },
      { m: 'furniture/lampRoundFloor', p: [0.72, 0, -0.85] },
      { m: 'furniture/tableCoffeeGlass', p: [0.6, 0, -0.15], id: 'table' },
      { m: 'food/mug', p: [0.52, 0, -0.15], s: 0.22, on: 'table' },
      { m: 'furniture/cabinetTelevision', p: [-1.35, 0, -0.35], r: 90, id: 'tv' },
      { m: 'furniture/televisionModern', p: [-1.38, 0, -0.35], r: 90, on: 'tv' },
      { m: 'furniture/rugRounded', p: [0, 0, -0.35] },
    ],
    home: [0, 0.05],
    work: { at: [0.33, 0.12], face: [0.6, -0.15], anim: 'interact-right' },
    idle: [{ at: [-0.95, -0.35], face: [-1.35, -0.35], anim: 'interact-left' }],
  },

  park: {
    env: OUTDOOR('#86c96b', '#bfe4ff'),
    props: [
      { m: 'nature/tree_oak', p: [-1.3, 0, -1.6], s: 1.4 },
      { m: 'nature/tree_default', p: [1.25, 0, -1.9], s: 1.3 },
      { m: 'nature/tree_detailed', p: [-0.1, 0, -2.7], s: 1.3 },
      { m: 'nature/tree_fat', p: [2.2, 0, -1.2], s: 1.2 },
      { m: 'nature/tree_pineRoundA', p: [-2.3, 0, -1.0], s: 1.3 },
      { m: 'furniture/bench', p: [0.85, 0, -0.85], s: 1.2, r: -10 },
      { m: 'nature/plant_bushLarge', p: [-0.7, 0, -0.95] },
      { m: 'nature/plant_bush', p: [1.5, 0, -0.55] },
      { m: 'nature/flower_redA', p: [-0.4, 0, -0.6] },
      { m: 'nature/flower_yellowA', p: [0.3, 0, -1.15] },
      { m: 'nature/flower_purpleA', p: [-1.05, 0, -0.3] },
      { m: 'nature/flower_redA', p: [1.2, 0, -0.1] },
      { m: 'nature/grass_large', p: [1.05, 0, 0.15] },
      { m: 'nature/grass_large', p: [-1.3, 0, 0.1] },
      { m: 'nature/rock_smallA', p: [0.45, 0, -0.45] },
      { m: 'nature/stump_round', p: [-1.1, 0, -1.25] },
    ],
    home: [0, 0.05],
    work: { at: [-0.62, -0.5], face: [-0.7, -0.95], anim: 'interact-left' },
    idle: [
      { at: [0, 0.05], face: null, anim: 'jump', repeat: 3 },
      { at: [0.8, -0.45], face: [0.8, -0.8], anim: 'crouch' },
    ],
  },

  moonbase: {
    env: OUTDOOR('#a7abb5', '#0b1030', { stars: true, fog: '#1a2040' }),
    props: [
      { m: 'space/rocket_finsA', p: [-1.5, 0, -2.2], s: 0.55, id: 'r1' },
      { m: 'space/rocket_fuelA', p: [-1.5, 0, -2.2], s: 0.55, on: 'r1', id: 'r2' },
      { m: 'space/rocket_topA', p: [-1.5, 0, -2.2], s: 0.55, on: 'r2' },
      { m: 'space/satelliteDish_large', p: [1.5, 0, -1.9], s: 0.6, r: -30 },
      { m: 'space/craterLarge', p: [0.3, 0, -1.3] },
      { m: 'space/rock_crystals', p: [-0.65, 0, -0.9], s: 0.6 },
      { m: 'space/rock_crystalsLargeA', p: [2.0, 0, -0.8], s: 0.8 },
      { m: 'space/rocks_smallA', p: [1.0, 0, -0.3], s: 0.6 },
      { m: 'space/desk_computer', p: [0.5, 0, -0.75] },
      { m: 'space/rover', p: [-1.7, 0, -0.4], r: 35, s: 0.8 },
      { m: 'space/alien', p: [2.4, 0, -2.0], r: -30, s: 0.8 },
      { m: 'space/machine_generator', p: [-0.2, 0, -1.9], s: 0.8 },
    ],
    home: [0, 0.05],
    work: { at: [0.5, -0.38], face: [0.5, -1], anim: 'interact-right' },
    idle: [{ at: [-0.6, -0.5], face: [-0.65, -0.9], anim: 'pick-up' }],
  },

  library: {
    env: ROOM('#efe1c6', '#a47a54', { trim: '#f5a524' }),
    props: [
      { m: 'furniture/bookcaseClosedWide', p: [-0.85, 0, -0.85] },
      { m: 'furniture/bookcaseClosedWide', p: [0, 0, -0.85], id: 'shelf' },
      { m: 'furniture/bookcaseClosedWide', p: [0.85, 0, -0.85] },
      { m: 'furniture/lampSquareFloor', p: [1.45, 0, -0.7] },
      { m: 'furniture/pottedPlant', p: [-1.5, 0, -0.75] },
      { m: 'furniture/table', p: [0.95, 0, -0.2], id: 'table' },
      { m: 'furniture/books', p: [0.8, 0, -0.2], on: 'table' },
      { m: 'furniture/books', p: [0.83, 0.1, -0.2], r: 20, on: 'table' },
      { m: 'furniture/lampSquareTable', p: [1.2, 0, -0.28], on: 'table' },
      { m: 'furniture/chair', p: [0.95, 0, 0.15], r: 180 },
      { m: 'furniture/rugRectangle', p: [-0.2, 0, -0.2] },
    ],
    home: [0, 0.05],
    work: { at: [0, -0.45], face: [0, -1], anim: 'interact-right' },
    idle: [{ at: [0.55, -0.2], face: [0.95, -0.2], anim: 'interact-right' }],
  },

  campsite: {
    env: OUTDOOR('#7fae66', '#ffd2a1', { fog: '#ffc79a', campfire: [0.6, -0.45] }),
    props: [
      { m: 'nature/tent_detailedOpen', p: [-0.95, 0, -1.15], s: 1.3, r: 20 },
      { m: 'nature/campfire_stones', p: [0.6, 0, -0.45] },
      { m: 'nature/log', p: [1.05, 0, -0.25], r: 60 },
      { m: 'nature/log_stack', p: [1.5, 0, -1.1] },
      { m: 'nature/tree_pineTallA', p: [-2.0, 0, -1.7], s: 1.4 },
      { m: 'nature/tree_pineTallA', p: [1.9, 0, -2.0], s: 1.5 },
      { m: 'nature/tree_pineRoundA', p: [0.2, 0, -2.4], s: 1.4 },
      { m: 'nature/tree_default', p: [2.5, 0, -0.9], s: 1.2 },
      { m: 'nature/canoe', p: [-1.9, 0, -0.35], r: 70 },
      { m: 'nature/sign', p: [-0.1, 0, -0.95], s: 1.2 },
      { m: 'nature/stump_round', p: [1.05, 0, -1.25] },
      { m: 'nature/mushroom_redGroup', p: [-0.45, 0, -0.5] },
    ],
    home: [0, 0.05],
    work: { at: [-0.1, -0.62], face: [-0.1, -1], anim: 'interact-right' },
    idle: [{ at: [0.35, -0.2], face: [0.6, -0.45], anim: 'crouch' }],
  },
};
