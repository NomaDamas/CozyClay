# Motion in CozyClay 3: how the agent authors it

The agent writes a **motion spec**. The deterministic compiler bakes every frame on the real rig (X Bot or Y Bot), fixes small mechanical errors itself, and QA measures the result. Every QA issue group says what caused it and what to change. The agent edits the spec and compiles again until QA reports nothing. A 730-frame scene compiles in about 150 ms and QA takes about 80 ms, so iterate freely, normally inside one `script` call.

## Loop

1. Read the scene with `inspect_studio`: object ids, positions (base pivot = bottom centre), sizes, the character (`model`, `x/y/z`, `rot`).
2. Plan the beats with frame ranges at 24 fps. **Build them from skills first** (`spec.use`), then add your own keys for what no skill covers.
3. `run_action motion.compile { characterId, spec, install: false }`. Read `output.qa.groups`: each group has a `cause` and a `hint`.
4. Apply the hint of the largest group. When a value is a guess (a turn radius, a heading, a height), write it as `{ range: [lo, hi] }` and let the compiler search it. Compile again. Repeat until `qa.ok`.
5. `motion.compile` with `install: true`. Then do one `verify_result` contact sheet as a visual check.
6. Report the QA numbers, `output.fixed` (what the compiler changed for you), what was declared in `checks`, and anything that was not checked.

## Skills (`spec.use`)

`use: [{ skill, args, f0 }]` expands, in order, into keys, anchors, props, fits, objects and checks before compile. Each skill starts from the pose the earlier keys leave at its `f0`. Your own `keys` come after the skill keys, so your key on the same frame wins; your own anchors, props and fits replace a skill's of the same name. `output.skills` lists where each skill ends.

| Skill | Args | Does |
|---|---|---|
| `standIdle` | `at: [x, z]`, `heading`, `until` | Neutral standing pose, arms down (FK). The start pose for a walk. |
| `walkTo` | `to: [x, z]` or `heading: h \| [h0, h1]`, `steps`, `step`, `turnDistance`, `halfWidth`, `lift`, `firstStep`, `period`, `vary = 1` | The walk generator from the pose at `f0`. With `to`, it turns toward the point and picks the step count. Ends `16 + steps * period + 18` frames later, feet together. The steps keep a natural rhythm: the first steps build up, the last one slows into the stop, one side is a little quicker, no two steps are alike, and turns take shorter steps; `period`, `step`, `lift` and `armSwing` are averages, and the walk keeps its frames and its end point. `vary: 0` makes every step exactly `period` frames and `step` m; `2` is twice as uneven. |
| `reachGrip` | `anchor`, `side`, `define`, `reach = 20`, `hold = 22`, `release = 12`, `elbow`, `fingers = "grip"` | The hand goes to the anchor with the fingers closing, holds, lets go. Adds the fingertip fit and a contact check. |
| `sitInSeat` | `car` or `seat` (+ `seatBack`, `wheel`), `offset = [0, 0.17, 0.02]`, `floor` | Seated at the wheel, hands forward. Adds the seat support and the seat allowances. |
| `exitCar` | `car` or `seat` + `door` + `handle`, `side = "l"`, `channel = "door"` | Reach the inner handle, open the door, swivel, legs out, stand up with the hands on the thighs, two steps away. 246 frames. Follows the car's position and yaw; `side: "r"` mirrors it. Tuned on the X Bot for a seat base at y 0.4 m. |
| `smokeCigarette` | `until` | Cigarette from the right pocket to the lips, lighter from the left pocket under the tip, light, exhale, look around, a second drag. Needs 265 frames. |

`car: "Car"` fills the ids `Car_Seat_Driver`, `Car_Seat_Driver_Back`, `Car_Door_L` (or `_R`), `Car_Door_Handle`, `Car_Steering_Wheel`. The whole car-exit scene is four lines:

```js
use: [
  { skill: "sitInSeat", f0: 0, args: { car: "Car", offset: [-0.06, 0.17, 0.023] } },
  { skill: "exitCar", f0: 0, args: { car: "Car" } },
  { skill: "walkTo", f0: 246, args: { heading: [125, 150], steps: 8, turnDistance: 0.4 } },
  { skill: "smokeCigarette", f0: 440 },
]
```

## Reading QA: cause and hint

Every group: `{ kind, subject, count, first, last, worst, worstFrame, limit, cause, hint }`.

- `cause` names the spec element most responsible at the worst frame: a key and channel (`keys[12] f200 hand_r`), the two keys around the frame (`root between keys[3] f84 and keys[7] f97`), an anchor and its fit (`anchor mouth (fits[1]) via keys[50] f498 w_mouth_r`), a generator step (`generators[0] walk step 3 f316 root`), or a skill (`use[1] exitCar f116 foot_l`).
- `hint` says what to change, with a direction and an amount in world metres or degrees, at a frame. Examples:
  - `root: move [0, +0.026, 0] m at f0 (out of Car_Seat_Driver)`. Add the vector to that key.
  - `retime: stretch f300-f312 by 1.4x (+5 frames, move the keys from f312 on later); or fix.retime: true`.
  - `cig_vis: move the step from f454 to f460 (RightHand 0 m from rpocket there)`.
  - `elbow_r: key [+0.5, -1, +0.5] (body frame: +y up, +z forward) at f497`.
  - `walk path: root needs [+0.049, 0, +0.122] m at f315 (out of Car_Door_L); change that walk's heading/turnDistance/step (or give one a { range: [lo, hi] })`.
- Hints are local: they come from the worst frame. Apply one, compile, read again.

## Auto-fixes (`spec.fix`)

The compiler fixes small mechanical errors itself and reports each fix in `output.fixed` (frames, worst amount). QA still measures the final frames, and the limits are never loosened.

| Fix | Default | What it does |
|---|---|---|
| `reach` | on | A wrist target up to 5 cm past the arm's reach goes onto it through a soft knee, so the arm never snaps straight. An ankle target up to 5 cm past the leg's reach lowers the hips just enough, eased over 6 frames. Farther misses stay for QA (`REACH`). |
| `slide` | on | A sole point under the floor lifts its ankle onto the floor (`fixed.ground`), so a squat with the heels up stands on the balls of the feet. A planted heel or ball that drifts less than 1 cm stays where it landed. A foot that turns (`fyaw`, `fpitch`) on its planted ball with the heel up, or on its planted heel, pivots about that point whatever the drift (`fixed.slide.pivots`): a batter's back foot turns on its ball. |
| `penetration` | off; `0.02` or `true` | A hand or forearm inside a scene box by at most this much past its allowance moves out along the box normal, eased. FK arms (`armw` 0) are counted as `skipped`. |
| `retime` | off; `true` | Key intervals around a speed or acceleration spike get longer, borrowed from the neighbouring key intervals. The frame count stays. Frame-range checks follow. |

`fix: false` turns everything off.

## Open parameters (`{ range: [lo, hi] }`)

Any number may be `{ range: [lo, hi] }` (or `{ search: [lo, hi] }`, add `int: true` for whole numbers): generator params, key channel values or one vector component, anchor offsets, skill args. `motion.compile` searches the values: the midpoint first, then a grid (one parameter) or Halton points (several), then a shrinking pattern search around the best. It stops at the first value with QA 0, and it never uses more than `search.budget` compiles (default 32, max 64). Each trial compiles only the frames the parameters can change. `output.search = { values: { path: value }, evals, cost, window, ms }`; `cost` 0 means clean. The installed take keeps the chosen numbers.

Example: walking off past an open door. `turnDistance: { range: [0.2, 2.0] }` found 1.55 in 5 compiles (0.8 s) where 0.4 by hand hit the door on 93 frames.

## Conventions and signs

- World metres, +Y up, floor at y = 0.
- `yaw`: 0 faces +Z; **+ turns toward +X**, which is the character's left at yaw 0 (a left turn). `fyaw_l/r` and `spine_yaw`/`head_yaw` use the same sign: + looks or turns to the character's left.
- `pitch`, `spine_pitch`, `head_pitch`: **+ bends forward** (head + looks down).
- `roll`, `spine_roll`, `head_roll`: + leans to the character's right.
- `fpitch_l/r`: toe-down pitch. **+ lifts the heel** (toe-off, the toes stay flat), - lifts the toes. Range -60..90.
- Poles (`knee_l/r`, `elbow_l/r`) and `body` anchors are **body-frame**: turned by the root yaw only. +z forward, +x the character's left, +y up. Knees bend toward +z; the default elbow pole is `[0, -1, -0.3]` (down and back). Never interpolate between opposite poles: the pole passes through zero and the limb flips. Add an in-between key.
- `aswing` + swings the arm forward; `abend` + bends the elbow.
- `wtwist`/`wflex` are clamped to ±85 and ±70. A mirrored pose negates them.
- A hinge angle turns about its axis by the right-hand rule: about `[0, 1, 0]`, + turns +Z toward +X.
- `root` is the hips joint. Standing hips height is about 1.03 m on the X Bot and 0.99 m on the Y Bot. **`foot_*` is the ankle**: it stands 0.087 m (X Bot) or 0.105 m (Y Bot) above the floor, not 0.
- Anchor names must not end in `_l` or `_r`: the side goes on the weight channel (`w_handle_l`).

The compiler validates the spec strictly and lists every problem with an exact message, one per line, e.g. `keys[3] (f32) sets unknown channel "fpitch_left"; did you mean "fpitch_l"?` or `keys[6] (f54) knee_l = [0,0,-1] points backward; knees bend toward +z.` Unknown channels, wrong vector arity, frames out of range, `fps` other than 24, unknown anchors, bones, objects, fields and skills are all refused.

## Channels (keys: `[{ f, set: { channel: value }, step?: [channel] }]`)

A channel is interpolated (monotone cubic) only through the keys that set it, so re-key a value to hold it. A `step` key jumps exactly on its frame; use it for visibility switches. Custom channels are hinge angles (`objects`), channels a check names, names ending in `_vis`, and names listed in `spec.channels`.

| Channel | Meaning |
|---|---|
| `root [x,y,z]`, `yaw`, `pitch`, `roll` | Hips position and body turn |
| `spine_yaw/pitch/roll`, `head_yaw/pitch/roll` | Spread over the chain |
| `foot_l/r [x,y,z]`, `fyaw_l/r`, `fpitch_l/r` | Ankle target, foot heading, toe-down pitch |
| `knee_l/r [x,y,z]` | Body-frame knee direction (default forward) |
| `armw_l/r` | 0 = FK arm (`aswing`, `abend`), 1 = IK to the hand target |
| `hand_l/r [x,y,z]` | World wrist target |
| `w_<anchor>_l/r` | Weight that pulls the hand target to a named anchor (weights add up; the rest is `hand_*`) |
| `elbow_l/r [x,y,z]` | Body-frame elbow direction |
| `wtwist_l/r`, `wflex_l/r` | Wrist twist and flex in degrees |
| `fingers_l/r { relaxed, fist, grip, cigarette, point }` | Preset weights over relaxed |

Flow (`spec.flow`) also leads the head into a turn: `headLead` (default on, 5 frames; a whole number 0..12 sets the frames, `false` turns it off). Walking or standing, the head takes the turn the trunk (`yaw` + `spine_yaw`) makes over the next frames, at most 30 degrees, so the head turns first. It skips any span where your keys move `head_yaw`. `observations.life.lead` reports `[frames the head turns before the pelvis, correlation]`.

## Anchors, props and fits

- Anchors are where a hand goes:
  - `world` — fixed point
  - `body` — relative to the root, turns with the yaw
  - `bone` — offset from a joint
  - `segment` — a point along a bone; with `reach`, it slides until the arm reaches
  - `object` — a point fixed to a scene object, including a hinged door
  - `landmark mouth` — the measured face point
  - `prop` — a point on a prop held by the other hand, plus an optional world `offset` (e.g. 2 cm under the cigarette tip)
- Props are points carried by a hand, given along the palm axes [finger d, knuckle line l, palm normal n].
- Fits move the wrist until an effector (a prop point or fingertips) sits exactly on an anchor while that anchor's weight is on.
- Objects: `objects: { id: { pivot, axis, channel } }` hinges a scene object by a keyed angle channel. Use it for doors.
- Carried objects: `objects: { id: { prop, at, along, visible } }` puts a scene object (a small cylinder, cone or box you placed) on a held prop every frame. `at` is its base along the palm axes [d, l, n] from the prop origin, `along` the palm direction its +Y takes, and `visible` a channel that shows it above 0.5 (step it on when the hand leaves the pocket). Carried objects are not obstacles for QA.

## Grasp, weight, throw and catch (`fix.grasp`, on by default)

- Grasp: a carried object with no `at`/`along` (a ball, a can, a cup) rests in the palm where the hand takes it, eases in over 4 frames, and the fingers close until they touch it. Do not pin it on a knuckle point with `at`; pinned grips (a bat, a sword, a pistol) stay as given. `objects.<id>.grasp` names the hold when it matters: `power`, `pinch`, `hook`, `palm`, `spherical` (a ball). QA says when the hand does not hold it: `FINGER_PEN` (a finger in it), `FINGER_GAP` (fewer than three fingertips, or the thumb and two, on it), `SUPPORT` (nothing holds it up). `fix: { grasp: false }` keeps the old preset grip; its QA then patches grasp back on. On every frame, with or without a held thing, QA also reads each finger: `FINGER_ROM` (a joint bent back or curled past what a finger does) and `FINGER_SELF` (two fingers lying in each other). Presets keyed together share one curl: weights past a sum of 1 are scaled down. While a hand carries a seated object its grasp preset stays on (the thumb keeps wrapping a ball after reachGrip lets go), and `THUMB_OFF` reports a power or spherical hold whose thumb is off it.
- Weight: `objects.<id>.mass` (kg; a small sphere defaults to a 0.15 kg ball, else its volume as wood) lowers a plain hand target (6 mm per kg, 6 cm at most) and bends the elbow more. `observations.load` lists what each hand carries (kg, most N m). Past 25 N m on one hand QA says `LOAD`; for a right-hand carry its patch adds the left hand on the far face.
- Throw: `throwObject { object, to: [x, y, z], arc: "low" | "high" }` throws what that hand carries: wind-up, swing, release, follow-through. It writes the carry's `release`, a `fall { at, v }` with the launch velocity, and a goal near `to`. A fall with `v` (m/s) leaves with that velocity; `v: "hand"` takes the hand's at the release. A release with no fall stays where the hand let it go.
  `use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }, { skill: "throwObject", f0: 10, args: { object: "ball", to: [0, 0, 5] } }], objects: { ball: { prop: "ballGrip", at: [0, 0, -0.035], along: [0, 1, 0], grab: 4 } }`
- Catch: a flying thing is `objects.<id>.fall { at, v }`. `catchObject { object, side: "r" | "both" }` reaches the first point of the flight in front of the chest the hand can reach, takes it (the carry is filled in), and gives with it 8-15 cm. Out of reach is refused with the nearest frame and point; a hand that comes late is `CATCH "<id> missed by <cm>"`, its patch starts the skill earlier. Over 1 kg it takes both hands.
  `use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }, { skill: "catchObject", f0: 12, args: { object: "ball" } }], objects: { ball: { fall: { at: 12, v: [0, 2.5, -9] } } }` (the ball at [0, 1.6, 6])

## Generators

`{ type: "walk", f0, steps, step, heading: [h0, h1], turnDistance, halfWidth, lift, vary }` plans footsteps from the pose the keys leave at `f0`. Prefer the `walkTo` skill: it expands the same walk at once, so later skills start from where the walk ends.

## QA

Every take gets these checks: body capsules against scene boxes and ground contact, IK reach, planted-foot slide, bone length, speed and pops, knee and elbow flips, knee hyper-extension, hands and props entering the head or the torso, the two hands overlapping, hinged objects passing through other boxes, balance, and self contact.

A take with a walk also gets `observations.gait`, read over the walks only: steps, cadence `[steps/min, "100-115"]`, `stepLength` (m), `speed` (m/s), `stance` `[L, R]` (the share of each foot's stride on the ground), and the pelvis's `rotation` and `obliquity` (deg) and `vertical` and `lateral` (cm), peak to peak per stride. `warnings` lists the values outside a person's walk: cadence outside 80-140, stance outside 0.55-0.65, pelvis rotation outside 3.7-15.3 deg, obliquity outside 2.4-12.4 deg, and vertical outside 2.7-5 cm (provisional). They are warnings, not QA: `qa.ok` does not change. A walk of fewer than 4 steps reports only `steps`. The default `walkTo` is a slow stroll (about 74 steps/min); `period: 14, step: 0.6` walks about 104.

Declare the task-specific checks in `spec.checks` (skills add their own): `contacts`, `orient`, `below`, `clearance`, `appear`, `supports`, `allow`. Pass the QA numbers to the user as they are. QA proxies are capsules, boxes and an ellipsoid, not the skin.
