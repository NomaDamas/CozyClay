"""
cozyclay-gen / rewriter.py
Scene description (any language) -> mocap-grade MiniMax-H3 prompt, using the h3-mocap-prompting skill
as the system prompt. Backends: local Qwen3-8B (default, same GPU) or OpenAI (COZYCLAY_LLM=openai + OPENAI_API_KEY).
"""
import os, re, json, logging, threading

log = logging.getLogger("cozyclay-gen.rewriter")

SKILL_SYSTEM = r"""You are the prompt writer for a MiniMax-H3 video model used to generate SINGLE-PERSON FULL-BODY motion clips
that will be lifted to skeleton animation (mocap) with GVHMR / SAM 3D Body. The user gives a short scene description
(often Korean). You output ONLY the final H3 prompt in the official Ref2VA contract below. No commentary, no markdown.

The reference image <Picture 1> always exists: a gray human figure standing in an empty studio (dark wall, light floor),
seen from a three-quarter, slightly elevated camera. It defines the figure, the camera angle and the environment.

CONTRACT (keep field names and order exactly):

subject_definitions:
<Subject 1> is the gray human figure in <Picture 1>; body, proportions and gray surface come from <Picture 1>. <Picture 1> is also the camera angle, framing and environment reference.
(If the user explicitly asks for a real person / human / 사람, instead write: "<Subject 1> is a real young adult in a plain t-shirt, jeans and sneakers, with a clearly defined face. <Picture 1> is a pose, camera and environment reference only; it shows a gray figure, but <Subject 1> is a real human." and in retention_analysis say appearance is NOT taken from the picture.)
(If the user asks for a prop, add it here: "<Subject 1> carries a wooden baseball bat.")

summary:
[reference generation] one continuous fixed-camera shot of <Subject 1> starting in the pose, position and framing of <Picture 1>, <one-sentence action summary>, and then standing motionless for the rest of the clip.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - body, proportions and gray surface from <Picture 1> are retained. The environment and the camera angle from <Picture 1> are fully preserved.
(If the user asks for a different environment, say the studio is not used and describe the new setting in one sentence.)

detailed_description:
[Shot 1] Live-action, documentary, a locked-off full-body wide shot from the three-quarter, slightly elevated angle of <Picture 1>, tilted down a little so the floor and the feet are clearly visible. The camera holds a static shot; the frame never moves; no pan, no tilt, no push in, no zoom, no cuts, no reframing. <Subject 1> stays at the same distance from the camera the whole time and never comes closer to it; the whole body from head to feet stays inside the frame with empty space above the head and below the feet for the entire clip, and nothing ever comes between the camera and <Subject 1>. <TIMED BEATS> Only one person; no extra people, no soft dissolves, no fluid morphs, no motion blur, no on-screen text, no dialogue. Lips remain closed.

overall_soundscape: Quiet indoor room tone, soft footsteps on a hard floor, then silence. No speech.

non_diegetic_music: N/A

RULES FOR <TIMED BEATS> (this is where the scene goes):
- Write the action as 3 to 6 ordered beats in plain sentences, one action per sentence, starting with "<Subject 1> ...".
  Do NOT write timestamps or second ranges. Use order words instead: "First", "Then", "After that", "Finally".
- Beat level, not joint level: say what the body does (walks a few steps, drops into a crouch, rolls forward, settles prone), not every joint angle.
- Mention the clip length once in natural language, e.g. "The whole action unfolds slowly across the fifteen-second clip."
- Each action happens exactly once. Say "exactly once and is not repeated" for the main action.
- The LAST beat is always a hold: "Finally <Subject 1> settles into the end pose and stays completely motionless in it, breathing only, until the last frame; nothing else happens."
- Motion stays across the frame at constant distance from the camera; never toward or away from the camera. Say "toward screen left/right".
- The subject never leaves the frame, never goes behind an object, is never occluded. Falls end on the visible floor. Forward rolls / tumbling only if the user asks for them (self-occlusion hurts mocap) and then keep them short and tight.
- Feet stay on the floor unless the action clearly leaves the ground (jump). Full body always visible.
- If the user names a prop (bat, rifle, ball), declare it in subject_definitions ("<Subject 1> carries a wooden baseball bat.") and keep it in the hands through the beats.
- Output English only. Output the contract only.
"""

FEW_SHOT_USER = "걸어와서 카메라를 향해 절하는 장면 (15초)"
FEW_SHOT_ASSISTANT = """subject_definitions:
<Subject 1> is the gray human figure in <Picture 1>; body, proportions and gray surface come from <Picture 1>. <Picture 1> is also the camera angle, framing and environment reference.

summary:
[reference generation] one continuous fixed-camera shot of <Subject 1> starting in the pose, position and framing of <Picture 1>, taking a few steps across the frame, stopping, performing one single deep formal Korean full bow toward the camera, rising, and then standing motionless for the rest of the clip.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - body, proportions and gray surface from <Picture 1> are retained. The environment and the camera angle from <Picture 1> are fully preserved.

detailed_description:
[Shot 1] Live-action, documentary, a locked-off full-body wide shot from the three-quarter, slightly elevated angle of <Picture 1>, tilted down a little so the floor and the feet are clearly visible. The camera holds a static shot; the frame never moves; no pan, no tilt, no push in, no zoom, no cuts, no reframing. <Subject 1> stays at the same distance from the camera the whole time and never comes closer to it; the whole body from head to feet stays inside the frame with empty space above the head and below the feet for the entire clip, and nothing ever comes between the camera and <Subject 1>. The whole action unfolds slowly across the fifteen-second clip. First <Subject 1> starts standing as in <Picture 1> and walks a few calm steps across the frame toward screen left, then stops and turns to face the camera. Then <Subject 1> brings both hands together in front of the body and pauses. After that <Subject 1> slowly kneels down, places both hands flat on the floor, and lowers the forehead toward the hands with a flat back, holding the lowest point of the bow for a moment; the bow happens exactly once and is not repeated. Then <Subject 1> rises in one smooth motion, sits back on the heels, and stands up straight. Finally <Subject 1> settles into the standing pose with hands together and stays completely motionless in it, breathing only, until the last frame; nothing else happens. Only one person; no extra people, no soft dissolves, no fluid morphs, no motion blur, no on-screen text, no dialogue. Lips remain closed.

overall_soundscape: Quiet indoor room tone, soft footsteps on a hard floor, a light rustle as the knees and hands touch the floor, then silence. No speech.

non_diegetic_music: N/A"""


class Rewriter:
    def __init__(self, backend=None, model_id=None):
        self.backend = backend or os.environ.get("COZYCLAY_LLM", "local")
        self.model_id = model_id or os.environ.get("COZYCLAY_LLM_MODEL", "Qwen/Qwen3-8B")
        self._lock = threading.Lock()
        self._model = self._tok = None

    # ---- local (transformers) ----
    def _load_local(self):
        if self._model is not None:
            return
        import torch
        from transformers import AutoTokenizer, AutoModelForCausalLM
        log.info("loading rewriter LLM %s", self.model_id)
        self._tok = AutoTokenizer.from_pretrained(self.model_id)
        self._model = AutoModelForCausalLM.from_pretrained(self.model_id, dtype=torch.bfloat16).to("cuda")
        self._model.eval()
        log.info("rewriter LLM ready")

    def _messages(self, scene, seconds):
        user = f"{scene.strip()}\n\nClip length: {seconds:.0f} seconds."
        return [
            {"role": "system", "content": SKILL_SYSTEM},
            {"role": "user", "content": FEW_SHOT_USER},
            {"role": "assistant", "content": FEW_SHOT_ASSISTANT},
            {"role": "user", "content": user},
        ]

    def _local(self, scene, seconds):
        import torch
        self._load_local()
        msgs = self._messages(scene, seconds)
        text = self._tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True, enable_thinking=False)
        ids = self._tok([text], return_tensors="pt").to(self._model.device)
        with torch.inference_mode():
            out = self._model.generate(**ids, max_new_tokens=1200, do_sample=False, temperature=None, top_p=None, top_k=None)
        gen = self._tok.decode(out[0][ids.input_ids.shape[1]:], skip_special_tokens=True)
        return gen

    # ---- openai ----
    def _openai(self, scene, seconds):
        import urllib.request
        key = os.environ["OPENAI_API_KEY"]
        body = json.dumps({"model": os.environ.get("COZYCLAY_LLM_MODEL", "gpt-4o-mini"), "temperature": 0.2,
                           "messages": self._messages(scene, seconds)}).encode()
        req = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=body,
                                     headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)["choices"][0]["message"]["content"]

    def rewrite(self, scene, seconds=15.0):
        with self._lock:
            out = self._openai(scene, seconds) if self.backend == "openai" else self._local(scene, seconds)
        out = re.sub(r"<think>.*?</think>", "", out, flags=re.S).strip()
        out = out.strip("`").strip()
        i = out.find("subject_definitions:")
        if i > 0:
            out = out[i:]
        if "non_diegetic_music" not in out:
            out += "\n\nnon_diegetic_music: N/A"
        return _fix_timeline(out, float(seconds))


HOLD = ("<Subject 1> stays completely motionless in the final pose, breathing only, and does nothing else; "
        "there is no repeat of the action and no further movement until the last frame.")


def _fix_timeline(text, seconds):
    """No timestamps anymore; just make sure the contract ends with a hold and mentions the length."""
    if "motionless" not in text:
        hold = " Finally <Subject 1> settles into the end pose and stays completely motionless in it, breathing only, until the last frame; nothing else happens."
        text = text.replace(" Only one person;", hold + " Only one person;", 1) if " Only one person;" in text else text + hold
    return text
