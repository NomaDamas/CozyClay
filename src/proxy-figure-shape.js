// Capsule figure dimensions in metres, shared by the renderer
// (proxy-figure.jsx) and the rig-free bounds (character-kind.js).
export const PROXY_BODY_RADIUS = 0.22;
export const PROXY_BODY_HEIGHT = 1.45;
export const PROXY_HEAD_RADIUS = 0.12;
// Head centre sits this far above the top of the body or torso.
export const PROXY_HEAD_LIFT = 0.13;
// Sit is an L: a vertical torso at the hip and one leg capsule on the floor
// reaching this far forward of the hip, along the way the figure faces (+z).
export const PROXY_SIT_TORSO_HEIGHT = 0.85;
export const PROXY_SIT_LEG_REACH = 0.55;
