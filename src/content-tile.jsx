// The Content grid's tile and its grab wire, shared by the asset pane's
// folders (asset-pane.jsx) and the sculpt shelf (sculpt-shelf-tiles.jsx).

/** The grab wire every card shares: left button only, App owns the rest. */
export function grabProps(onAssetGrab, payload) {
	return {
		onPointerDown: (event) => {
			if (event.button !== 0) return;
			event.preventDefault();
			onAssetGrab?.(payload, event);
		},
	};
}

/** The Content grid's one tile grammar: a square thumbnail, an 11px name and
 * a 10px type line. Click selects (amber ring), a left-button press starts the
 * App-owned drag, double-click places the asset at the origin. */
export function ContentTile({ assetKey, label, type, title, preview, selected, onSelect, grab, onPlace, failed = false }) {
	return (
		<button
			type="button"
			className={"content-tile" + (failed ? " is-failed" : "")}
			data-testid="content-asset"
			data-asset-key={assetKey}
			aria-pressed={selected}
			title={title}
			{...(grab ?? {})}
			onClick={() => onSelect(assetKey)}
			onDoubleClick={onPlace ? () => onPlace() : undefined}
		>
			<span className="content-tile-thumb">{preview}</span>
			<span className="content-tile-name">{label}</span>
			<span className="content-tile-type">{type}</span>
		</button>
	);
}
