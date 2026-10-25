// The closed list of primary Studio controls that carry `data-fid`, for
// ui:rage_click and ui:dead_click. A click on any other control reports "other".
// Ids name a control, never a scene object, a name or any text.
export const CONTROL_IDS = Object.freeze([
	"dock_tab_board", "dock_tab_animation", "dock_tab_assets",
	"mode_scene", "mode_pose", "mode_camera", "mode_motion", "mode_sculpt",
	"tool_move", "tool_rotate", "tool_scale", "tool_ik", "tool_pin", "tool_front", "tool_side", "tool_back",
	"tl_play", "shot_add", "shot_delete", "camera_key_add",
	"export_animation_project", "export_keyframe_pack", "export_video", "export_video_shot",
	"export_render_passes", "export_depth_video", "export_storyboard", "export_otio",
	"menu_undo", "menu_redo",
	"agent_send", "agent_stop", "agent_steer", "agent_retry", "agent_connect", "agent_panel",
	"board_export", "board_stylize",
]);

/** The closed control id of a `data-fid` value, else "other". */
export const controlOf = (fid) => (CONTROL_IDS.includes(fid) ? fid : "other");
