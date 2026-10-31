import * as THREE from 'three';

// Highlight overlay for merged/physical meshes.
//
// A physical Mesh may contain several logical Draws (primitive spans). Tinting the
// mesh material would highlight every Draw in that mesh, so instead we render a
// separate overlay whose index buffer contains only the selected spans. Position
// and normal attributes are shared with the source geometry (no copy); only the
// selected index range is duplicated.
export function createHighlighter(scene) {
  const group = new THREE.Group();
  group.name = 'highlight-overlay';
  group.renderOrder = 10;
  scene.add(group);
  const material = new THREE.MeshBasicMaterial({
    color: 0x35d6ff,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const lineMaterial = new THREE.LineBasicMaterial({
    color: 0x7fe9ff, transparent: true, opacity: 0.9, depthWrite: false, depthTest: true,
  });
  // Dimming is also span-scoped: a complement index buffer covers every Draw except the
  // selected one, so sibling Draws inside the same physical Mesh are not dimmed together.
  const dimMaterial = new THREE.MeshBasicMaterial({
    color: 0xe4eaef, transparent: true, opacity: 0.72, depthWrite: false, depthTest: true,
    side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  const dimLineMaterial = new THREE.LineBasicMaterial({color: 0xd7dee5, transparent: true, opacity: 0.5, depthWrite: false});
  let stats = { meshes: 0, triangles: 0, segments: 0, indexBytes: 0, dimMeshes: 0, dimIndices: 0 };

  function spansFor(mesh, id) {
    const spans = mesh.userData.primitiveSpans;
    if (spans) {
      return spans.filter((s) => s.renderItemId === id).map((s) => ({
        firstIndex: s.firstIndex ?? (s.firstTriangle ?? 0) * 3,
        indexCount: s.indexCount ?? (s.triangleCount ?? 0) * 3,
        renderItemId: id,
      }));
    }
    const range = mesh.geometry.drawRange;
    if (mesh.userData.renderItemId === id) {
      return [{ firstIndex: range.start, indexCount: range.count, renderItemId: id }];
    }
    return [];
  }

  function build(drawIds, drawObjects, {dim = false, dimExcludedDrawIds = drawIds} = {}) {
    clear();
    const byMesh = new Map();
    for (const id of drawIds) {
      const entry = drawObjects.get(id);
      const mesh = entry?.userData?.renderObject || entry;
      if (!mesh || mesh.isLineSegments === false && !mesh.geometry) continue;
      const list = byMesh.get(mesh) || [];
      for (const span of spansFor(mesh, id)) list.push(span);
      byMesh.set(mesh, list);
    }
    for (const [mesh, spans] of byMesh) {
      const source = mesh.geometry;
      const position = source.attributes.position;
      if (!position) continue;
      const indices = source.index;
      if (!indices) continue;
      const topology = mesh.userData.topology || 'triangles';
      const parts = [];
      let total = 0;
      for (const span of spans) {
        parts.push([span.firstIndex, span.indexCount]);
        total += span.indexCount;
      }
      if (!total) continue;
      const array = new Uint32Array(total);
      let at = 0;
      for (const [first, count] of parts) {
        for (let i = 0; i < count; i += 1) array[at++] = indices.getX(first + i);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', position);
      if (source.attributes.normal) geometry.setAttribute('normal', source.attributes.normal);
      geometry.setIndex(new THREE.BufferAttribute(array, 1));
      const overlay = topology === 'lines'
        ? new THREE.LineSegments(geometry, lineMaterial)
        : new THREE.Mesh(geometry, material);
      overlay.matrixAutoUpdate = false;
      mesh.updateWorldMatrix(true, false);
      overlay.matrix.copy(mesh.matrixWorld);
      overlay.renderOrder = 10;
      overlay.frustumCulled = false;
      overlay.userData.highlight = true;
      overlay.userData.sourceMesh = mesh;
      overlay.raycast = () => {};
      group.add(overlay);
      if (topology === 'lines') stats.segments += total / 2; else stats.triangles += total / 3;
      stats.indexBytes += array.byteLength;
    }
    if (dim) buildDim(drawObjects, dimExcludedDrawIds);
    stats.meshes = group.children.length;
    syncVisibility();
    return stats;
  }

  function buildDim(drawObjects, excludedDrawIds) {
    const selectedByMesh = new Map();
    for (const id of excludedDrawIds) {
      const entry = drawObjects.get(id), mesh = entry?.userData?.renderObject || entry;
      if (!mesh) continue;
      const spans = selectedByMesh.get(mesh) || [];
      spans.push(...spansFor(mesh, id));
      selectedByMesh.set(mesh, spans);
    }
    const meshes = new Set([...drawObjects.values()].map(entry => entry?.userData?.renderObject || entry));
    for (const mesh of meshes) {
      const source = mesh.geometry, indices = source.index;
      if (!indices || !source.attributes.position) continue;
      const first = source.drawRange.start, end = Math.min(indices.count, first + source.drawRange.count);
      const selected = selectedByMesh.get(mesh) || [];
      let dimIndex = indices, count = end - first, start = first;
      if (selected.length) {
        const excluded = new Uint8Array(count);
        for (const span of selected) excluded.fill(1, Math.max(first, span.firstIndex) - first, Math.min(end, span.firstIndex + span.indexCount) - first);
        const keep = count - excluded.reduce((sum, value) => sum + value, 0);
        if (!keep) continue;
        const array = new Uint32Array(keep);
        let at = 0;
        for (let i = first; i < end; i++) if (!excluded[i - first]) array[at++] = indices.getX(i);
        dimIndex = new THREE.BufferAttribute(array, 1);
        count = keep; start = 0;
      }
      if (!count) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', source.attributes.position);
      if (source.attributes.normal) geometry.setAttribute('normal', source.attributes.normal);
      geometry.setIndex(dimIndex);
      geometry.setDrawRange(start, count);
      const lines = (mesh.userData.topology || 'triangles') === 'lines';
      const overlay = lines ? new THREE.LineSegments(geometry, dimLineMaterial) : new THREE.Mesh(geometry, dimMaterial);
      overlay.matrixAutoUpdate = false;
      mesh.updateWorldMatrix(true, false);
      overlay.matrix.copy(mesh.matrixWorld);
      overlay.renderOrder = 9;
      overlay.frustumCulled = false;
      overlay.raycast = () => {};
      overlay.userData.dim = true;
      overlay.userData.sourceMesh = mesh;
      group.add(overlay);
      stats.dimMeshes += 1;
      stats.dimIndices += count;
    }
  }
  function clear() {
    for (const child of group.children) child.geometry.dispose();
    group.clear();
    stats = { meshes: 0, triangles: 0, segments: 0, indexBytes: 0, dimMeshes: 0, dimIndices: 0 };
    return stats;
  }

  function shown(o) {
    for (let p = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  }

  function syncVisibility() {
    for (const overlay of group.children) {
      overlay.visible = !!overlay.userData.sourceMesh && shown(overlay.userData.sourceMesh);
    }
  }

  return { group, build, clear, syncVisibility, stats: () => ({ ...stats }), material, lineMaterial };
}

// Resolve the selected product/scene subtree, including assembly children.
function descendants(nodes, rootId) {
  const children = new Map();
  for (const [id, node] of Object.entries(nodes)) {
    const list = children.get(node.parentId) || [];
    list.push(id); children.set(node.parentId, list);
  }
  const ids = new Set(), pending = [rootId];
  while (pending.length) {
    const id = pending.pop();
    ids.add(id);
    pending.push(...(children.get(id) || []));
  }
  return ids;
}

export function drawsForProduct(document, productOccurrenceId) {
  const ids = descendants(document.productOccurrences, productOccurrenceId);
  return Object.entries(document.renderOwnership || {})
    .filter(([, owner]) => ids.has(owner)).map(([id]) => id);
}

export function drawsForScene(document, snapshot, sceneOccurrenceId) {
  const ids = descendants(document.sceneOccurrences, sceneOccurrenceId);
  return Object.entries(snapshot.draws || {})
    .filter(([, draw]) => ids.has(draw.occurrenceId)).map(([id]) => id);
}
