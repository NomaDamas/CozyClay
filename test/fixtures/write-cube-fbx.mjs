#!/usr/bin/env node
/**
 * Write tiny ASCII FBX ≥ 7.0 cubes for the mesh-import tests.
 *
 * Same standing box as write-cube-obj.mjs: sits on y = 0, centred on XZ.
 * The file must survive `FBXLoader.parse` — a header that merely looks like
 * FBX is not enough. No skeleton, no animation, no maps.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function cubeFbx(height) {
	const h = Number(height);
	const half = h / 2;
	const vertices = [
		[-half, 0, -half],
		[half, 0, -half],
		[half, 0, half],
		[-half, 0, half],
		[-half, h, -half],
		[half, h, -half],
		[half, h, half],
		[-half, h, half],
	];
	const vertexFlat = vertices.flat().join(",");
	// Last index of each quad is bitwise-not (three.js: vertexIndex ^ -1).
	const faces = [
		[0, 3, 2, 1],
		[4, 5, 6, 7],
		[0, 1, 5, 4],
		[1, 2, 6, 5],
		[2, 3, 7, 6],
		[3, 0, 4, 7],
	];
	const indexFlat = faces.flatMap((face) => {
		const [a, b, c, d] = face;
		return [a, b, c, -(d + 1)];
	}).join(",");
	return `; FBX 7.4.0 project file
FBXHeaderExtension:  {
	FBXHeaderVersion: 1003
	FBXVersion: 7400
	Creator: "CozyClay test cube"
}
GlobalSettings:  {
	Version: 1000
	Properties70:  {
		P: "UpAxis", "int", "Integer", "",1
		P: "UpAxisSign", "int", "Integer", "",1
		P: "FrontAxis", "int", "Integer", "",2
		P: "FrontAxisSign", "int", "Integer", "",1
		P: "CoordAxis", "int", "Integer", "",0
		P: "CoordAxisSign", "int", "Integer", "",1
		P: "UnitScaleFactor", "double", "Number", "",1
		P: "OriginalUnitScaleFactor", "double", "Number", "",1
	}
}
Documents:  {
	Count: 1
	Document: 1, "", "Scene" {
		Properties70:  {
			P: "SourceObject", "object", "", ""
		}
		RootNode: 0
	}
}
References:  {
}
Definitions:  {
	Version: 100
	Count: 3
	ObjectType: "GlobalSettings" {
		Count: 1
	}
	ObjectType: "Model" {
		Count: 1
	}
	ObjectType: "Geometry" {
		Count: 1
	}
}
Objects:  {
	Geometry: 1000001, "Geometry::Cube", "Mesh" {
		Vertices: *24 {
			a: ${vertexFlat}
		}
		PolygonVertexIndex: *24 {
			a: ${indexFlat}
		}
		GeometryVersion: 124
		Layer: 0 {
			Version: 100
		}
	}
	Model: 1000002, "Model::Cube", "Mesh" {
		Version: 232
		Properties70:  {
			P: "RotationActive", "bool", "", "",1
			P: "InheritType", "enum", "", "",1
			P: "DefaultAttributeIndex", "int", "Integer", "",0
			P: "Lcl Translation", "Lcl Translation", "", "A",0,0,0
			P: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0
			P: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1
		}
		Shading: T
		Culling: "CullingOff"
	}
}
Connections:  {
	C: "OO",1000001,1000002
	C: "OO",1000002,0
}
`;
}

export { cubeFbx };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const here = dirname(fileURLToPath(import.meta.url));
	mkdirSync(here, { recursive: true });
	const cubes = [
		["unit-cube.fbx", 1],
		["giant-cube.fbx", 50],
		["tiny-cube.fbx", 0.01],
	];
	for (const [name, height] of cubes) {
		const text = cubeFbx(height);
		writeFileSync(join(here, name), text);
		console.log(`wrote ${name} (${Buffer.byteLength(text)} bytes, height ${height} m)`);
	}
}
