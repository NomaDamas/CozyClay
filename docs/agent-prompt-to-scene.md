# Agent prompt-to-scene rules (ask / infer / omit)

Users paste an existing Seedance prompt into the Agent panel. This page is the rule the agent follows when turning that prompt into 3D blocking, so results stay consistent instead of depending on how the agent feels that day. The core idea comes from previz tools that already solve this: never over-ask, never silently guess.

## What to extract from the prompt

Read every prompt for six groups:

1. **Aspect ratio and overall duration** for the shot.
2. **Space and set pieces**: the room or location, and the objects that fill it.
3. **Characters**: how many, their relative position, their pose, which way they face, and where they look.
4. **Focus props**: the objects the prompt calls out by name.
5. **Per-shot details**: framing, camera direction, camera move, and that shot's duration.
6. **Dialogue or SFX timing**: what is said or heard, and when.

## Three tiers: ask, infer, omit

**ASK only when the frame cannot be judged without it.** The ask-list is short: aspect ratio, relative placement when two or more characters appear and the prompt gives no direction, per-shot framing or camera direction, and duration. Batch the questions, at most 5 in one round, and give every question a default so the user can just say "use defaults" and move on.

**INFER, and list the guess as an assumption.** These are safe defaults the agent picks and then states openly: character height, which side the camera sits on, that characters start standing, that each character faces the other, and field of view derived from shot size.

**OMIT without asking or guessing.** Dialogue timing, director intent, walk paths, and camera moves the prompt never states. The agent leaves these empty instead of inventing them.

## Which tools realise each group

| Group | Tools |
| --- | --- |
| Space and set pieces | `place_object`, `update_object`, `describe_scene` |
| Characters | `add_character`, `place_character`, `focus_character` |
| Per-shot framing and camera | `frame_shot`, `set_camera`, `mark_camera_move` |
| Dialogue or SFX timing | `set_prompt_blocks` |
| Anything the user confirms in one batch | `apply_batch` |
| Reading the result back | `describe_scene`, `describe_shot`, `capture_frame` |

All names above are the current tool names in `mcp/tool-handlers.mjs`; use only those.

## Known failure

LLM-generated coordinates overlap or float: two characters end up inside each other, or a character hovers above the floor. The fix is a loop, not a better guess: place everything, call `describe_scene` to read the actual positions, then correct the placements that look wrong. The agent should expect to run that loop at least once per scene.
