export function chooseIkEntryPose({ rememberedPose, editorPose, shotPose, lookThroughShot }) {
	return rememberedPose ?? (lookThroughShot ? shotPose : editorPose);
}
