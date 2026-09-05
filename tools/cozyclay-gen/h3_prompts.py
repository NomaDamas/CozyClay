"""
cozyclay-gen / h3_prompts.py
Mocap-oriented MiniMax-H3 prompt builders (official IR contract).
Mirrors skills/user/h3-mocap-prompting: fixed camera, 3/4 slightly elevated angle,
one person, full body, timed beats, explicit end hold, room tone, no music.
"""

MOCAP_CAMERA = (
    "The camera holds a static shot; the frame never moves; no pan, no tilt, no push in, "
    "no zoom, no cuts, no reframing."
)
MOCAP_FRAMING = (
    "<Subject 1> stays at the same distance from the camera the whole time and never comes closer to it; "
    "the whole body from head to feet stays inside the frame with empty space above the head and below "
    "the feet for the entire clip, and nothing ever comes between the camera and <Subject 1>."
)
MOCAP_CLEAN = (
    "Only one person; no extra people, no soft dissolves, no fluid morphs, no motion blur, "
    "no on-screen text, no dialogue. Lips remain closed."
)
SOUND = "Quiet indoor room tone, soft footsteps on a hard floor, then silence. No speech."


def beats_to_text(beats, total):
    """beats: list of (start, end, sentence). Fills the tail with a still hold."""
    parts = []
    last_end = 0.0
    for s, e, text in beats:
        parts.append(f"From {s:.2f} to {e:.2f} seconds {text}")
        last_end = e
    if last_end < total:
        parts.append(
            f"From {last_end:.2f} to {total:.2f} seconds <Subject 1> stays completely motionless in the final pose, "
            f"breathing only, and does nothing else; there is no repeat of the action and no further movement until the last frame."
        )
    return " ".join(parts)


def ref2va(summary_action, beats, seconds, subject="the gray human figure in <Picture 1>",
           human=False, angle_from_picture=True):
    """
    Ref2VA prompt. `beats` = [(start, end, "<Subject 1> does X"), ...].
    human=True rewrites the mannequin as a real person (detector-friendly).
    """
    if human:
        subj_def = (
            "<Subject 1> is a real young adult in a plain t-shirt, jeans and sneakers, with a clearly defined face. "
            "<Picture 1> is a pose, camera and environment reference only; it shows a gray figure, but <Subject 1> is a real human."
        )
        retention = (
            "Body pose, position in frame, camera angle and the floor come from <Picture 1>. "
            "Appearance is NOT taken from the picture; <Subject 1> is a realistic human with skin, hair and normal clothes."
        )
    else:
        subj_def = (
            f"<Subject 1> is {subject}; body, proportions and gray surface come from <Picture 1>. "
            "<Picture 1> is also the camera angle, framing and environment reference."
        )
        retention = (
            "<Subject 1> (appears in [Shot 1]): fully_preserved - body, proportions and gray surface from <Picture 1> are retained. "
            "The environment and the camera angle from <Picture 1> are fully preserved."
        )
    angle = (
        "from the three-quarter, slightly elevated angle of <Picture 1>, tilted down a little so the floor and the feet are clearly visible"
        if angle_from_picture else
        "from a three-quarter angle about 45 degrees off <Subject 1>'s line of travel, slightly above head height, tilted down a little so the floor and the feet are clearly visible"
    )
    return f"""subject_definitions:
{subj_def}

summary:
[reference generation] one continuous fixed-camera shot of <Subject 1> starting in the pose, position and framing of <Picture 1>, {summary_action}, and then standing motionless for the rest of the clip.

retention_analysis:
{retention}

detailed_description:
[Shot 1] Live-action, documentary, a locked-off full-body wide shot {angle}. {MOCAP_CAMERA} {MOCAP_FRAMING} {beats_to_text(beats, seconds)} {MOCAP_CLEAN}

overall_soundscape: {SOUND}

non_diegetic_music: N/A"""


def i2va(action_beats, seconds):
    return f"""For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Live-action, documentary. The shot begins on <Picture 1>, preserving the single person's identity, body proportions and full-body framing. {MOCAP_CAMERA} {MOCAP_FRAMING.replace('<Subject 1>', 'the person')} {beats_to_text(action_beats, seconds).replace('<Subject 1>', 'the person')} {MOCAP_CLEAN}

overall_soundscape: {SOUND}

non_diegetic_music: N/A"""


def fl2va(travel_text, seconds):
    return f"""How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the {seconds:.2f}-second mark of the target video.

integrated_multimodal_description: [Shot 1] Live-action, documentary, a locked-off full-body wide shot. The person begins in the pose and composition of Picture 1. {MOCAP_CAMERA} Only one person; head, hands and feet stay inside the frame. The body moves continuously along one path: {travel_text} Differences from Picture 2 narrow through the middle of the clip. By {seconds:.2f} seconds the person settles into the pose and composition of Picture 2 and holds still until the last frame. {MOCAP_CLEAN}

overall_soundscape: {SOUND}

non_diegetic_music: N/A"""


def template(mode="ref"):
    if mode == "ref":
        return ref2va(
            "taking a few steps across the frame, stopping, performing one single deep formal bow toward the camera, rising",
            [
                (0, 3, "<Subject 1> starts standing as in <Picture 1> and walks three calm steps across the frame, then stops and turns to face the camera."),
                (3, 5, "<Subject 1> stands facing the camera, brings both hands together in front of the body, and pauses."),
                (5, 7.5, "<Subject 1> slowly kneels down, places both hands flat on the floor, and lowers the forehead toward the hands with a flat back."),
                (7.5, 9, "<Subject 1> holds the lowest point of the bow completely still."),
                (9, 11, "<Subject 1> rises in one smooth motion: head and torso lift, sits back on the heels, then stands up straight."),
            ],
            15,
        )
    if mode == "i2v":
        return i2va([(0, 3, "the person begins [ACTION]."), (3, 4, "the person settles into the end pose.")], 5)
    return fl2va("[INTERMEDIATE MOTION].", 5)


if __name__ == "__main__":
    import sys
    print(template(sys.argv[1] if len(sys.argv) > 1 else "ref"))
