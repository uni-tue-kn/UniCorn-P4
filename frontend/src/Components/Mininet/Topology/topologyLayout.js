function nodeSort(a, b) {
    const matchA = String(a).match(/^([a-zA-Z_]+)(\d+)$/);
    const matchB = String(b).match(/^([a-zA-Z_]+)(\d+)$/);

    if (matchA && matchB) {
        if (matchA[1] !== matchB[1]) {
            return matchA[1].localeCompare(matchB[1]);
        }
        return Number(matchA[2]) - Number(matchB[2]);
    }

    return String(a).localeCompare(String(b));
}

function buildAdjacency(network) {
    const adjacency = {};

    network.nodes.forEach((node) => {
        adjacency[node.id] = [];
    });

    network.links.forEach((link) => {
        const source = typeof link.source === "object" ? link.source.id : link.source;
        const target = typeof link.target === "object" ? link.target.id : link.target;
        adjacency[source] = adjacency[source] || [];
        adjacency[target] = adjacency[target] || [];
        adjacency[source].push(target);
        adjacency[target].push(source);
    });

    return adjacency;
}

function isConnectedGraph(nodeIds, adjacency) {
    if (nodeIds.length < 2) {
        return true;
    }

    const allowed = new Set(nodeIds);
    const visited = new Set();
    const queue = [nodeIds[0]];
    visited.add(nodeIds[0]);

    while (queue.length > 0) {
        const current = queue.shift();
        (adjacency[current] || []).forEach((neighbor) => {
            if (!allowed.has(neighbor) || visited.has(neighbor)) {
                return;
            }
            visited.add(neighbor);
            queue.push(neighbor);
        });
    }

    return visited.size === nodeIds.length;
}

function isPathSwitchGraph(switchIds, switchAdj) {
    if (switchIds.length < 2 || !isConnectedGraph(switchIds, switchAdj)) {
        return switchIds.length < 2;
    }

    const degrees = switchIds.map((id) => (switchAdj[id] || []).length);
    const endpoints = degrees.filter((d) => d === 1).length;
    const invalid = degrees.some((d) => d < 1 || d > 2);

    return !invalid && endpoints === 2;
}

function isRingSwitchGraph(switchIds, switchAdj) {
    if (switchIds.length < 3 || !isConnectedGraph(switchIds, switchAdj)) {
        return false;
    }
    return switchIds.every((id) => (switchAdj[id] || []).length === 2);
}

function getStarCenterSwitch(switchIds, switchAdj) {
    if (switchIds.length < 4 || !isConnectedGraph(switchIds, switchAdj)) {
        return null;
    }

    const expectedLeaves = switchIds.length - 1;
    const center = switchIds.find((id) => (switchAdj[id] || []).length === expectedLeaves);
    if (!center) {
        return null;
    }

    const validLeaves = switchIds
        .filter((id) => id !== center)
        .every((id) => (switchAdj[id] || []).length === 1);

    return validLeaves ? center : null;
}

function orderPathSwitches(switchIds, switchAdj) {
    const endpoints = switchIds
        .filter((id) => (switchAdj[id] || []).length <= 1)
        .sort(nodeSort);
    const ordered = [];
    const visited = new Set();

    let current = endpoints[0] || [...switchIds].sort(nodeSort)[0];
    let previous = null;

    while (current && !visited.has(current)) {
        ordered.push(current);
        visited.add(current);
        const next = (switchAdj[current] || [])
            .filter((neighbor) => neighbor !== previous)
            .sort(nodeSort)
            .find((neighbor) => !visited.has(neighbor));
        previous = current;
        current = next;
    }

    if (ordered.length !== switchIds.length) {
        return [...switchIds].sort(nodeSort);
    }
    return ordered;
}

function orderRingSwitches(switchIds, switchAdj) {
    const ordered = [];
    const visited = new Set();
    const start = [...switchIds].sort(nodeSort)[0];
    let current = start;
    let previous = null;

    while (current && ordered.length < switchIds.length) {
        ordered.push(current);
        visited.add(current);
        const neighbors = [...(switchAdj[current] || [])].sort(nodeSort);
        const next = neighbors.find((neighbor) => neighbor !== previous && !visited.has(neighbor))
            || neighbors.find((neighbor) => neighbor !== previous)
            || null;
        previous = current;
        current = next;
        if (current === start) {
            break;
        }
    }

    if (ordered.length !== switchIds.length) {
        return [...switchIds].sort(nodeSort);
    }
    return ordered;
}

function buildSwitchAnchors(switchIds, switchAdj) {
    const anchors = {};
    const sortedSwitches = [...switchIds].sort(nodeSort);

    if (sortedSwitches.length === 0) {
        return { anchors, layoutType: "empty" };
    }

    if (sortedSwitches.length === 1) {
        anchors[sortedSwitches[0]] = { x: 0, y: 0 };
        return { anchors, layoutType: "single" };
    }

    if (!isConnectedGraph(sortedSwitches, switchAdj)) {
        const cols = Math.ceil(Math.sqrt(sortedSwitches.length));
        const spacingX = 118;
        const spacingY = 96;
        sortedSwitches.forEach((id, index) => {
            const col = index % cols;
            const row = Math.floor(index / cols);
            anchors[id] = {
                x: (col - (cols - 1) / 2) * spacingX,
                y: row * spacingY
            };
        });
        return { anchors, layoutType: "grid" };
    }

    if (isPathSwitchGraph(sortedSwitches, switchAdj)) {
        const ordered = orderPathSwitches(sortedSwitches, switchAdj);
        const spacing = 96;
        const startX = -((ordered.length - 1) * spacing) / 2;
        ordered.forEach((id, index) => {
            anchors[id] = {
                x: startX + index * spacing,
                y: 0
            };
        });
        return { anchors, layoutType: "path" };
    }

    const starCenter = getStarCenterSwitch(sortedSwitches, switchAdj);
    if (starCenter) {
        const leaves = sortedSwitches.filter((id) => id !== starCenter).sort(nodeSort);
        const radius = Math.max(96, leaves.length * 21);
        anchors[starCenter] = { x: 0, y: 0 };
        leaves.forEach((id, index) => {
            const angle = (-Math.PI / 2) + (2 * Math.PI * index) / leaves.length;
            anchors[id] = {
                x: radius * Math.cos(angle),
                y: radius * Math.sin(angle)
            };
        });
        return { anchors, layoutType: "star" };
    }

    if (isRingSwitchGraph(sortedSwitches, switchAdj)) {
        const ordered = orderRingSwitches(sortedSwitches, switchAdj);
        const radius = Math.max(96, ordered.length * 18);
        ordered.forEach((id, index) => {
            const angle = (-Math.PI / 2) + (2 * Math.PI * index) / ordered.length;
            anchors[id] = {
                x: radius * Math.cos(angle),
                y: radius * Math.sin(angle)
            };
        });
        return { anchors, layoutType: "ring" };
    }

    const root = [...sortedSwitches].sort((a, b) => {
        const degreeDiff = (switchAdj[b] || []).length - (switchAdj[a] || []).length;
        return degreeDiff !== 0 ? degreeDiff : nodeSort(a, b);
    })[0];
    const depth = {};
    const visited = new Set([root]);
    const queue = [root];
    depth[root] = 0;

    while (queue.length > 0) {
        const current = queue.shift();
        [...(switchAdj[current] || [])]
            .sort(nodeSort)
            .forEach((neighbor) => {
                if (visited.has(neighbor)) {
                    return;
                }
                visited.add(neighbor);
                depth[neighbor] = depth[current] + 1;
                queue.push(neighbor);
            });
    }

    const layers = {};
    sortedSwitches.forEach((id) => {
        const layer = depth[id] ?? 0;
        layers[layer] = layers[layer] || [];
        layers[layer].push(id);
    });

    const layerKeys = Object.keys(layers).map(Number).sort((a, b) => a - b);
    const layerSpacingX = 118;
    const layerSpacingY = 92;
    const startX = -((Math.max(layerKeys.length, 1) - 1) * layerSpacingX) / 2;
    layerKeys.forEach((layer) => {
        const layerNodes = layers[layer].sort(nodeSort);
        layerNodes.forEach((id, index) => {
            anchors[id] = {
                x: startX + layer * layerSpacingX,
                y: (index - (layerNodes.length - 1) / 2) * layerSpacingY
            };
        });
    });

    return { anchors, layoutType: "layered" };
}

function buildTopologyAnchors(network) {
    const anchors = {};
    const adjacency = buildAdjacency(network);
    const switchIds = network.nodes
        .filter((node) => node.type === "switch")
        .map((node) => node.id)
        .sort(nodeSort);
    const hostIds = network.nodes
        .filter((node) => node.type === "host")
        .map((node) => node.id)
        .sort(nodeSort);

    const switchSet = new Set(switchIds);
    const hostSet = new Set(hostIds);
    const switchAdj = {};

    switchIds.forEach((id) => {
        switchAdj[id] = (adjacency[id] || [])
            .filter((neighbor) => switchSet.has(neighbor))
            .sort(nodeSort);
    });

    const switchAnchorResult = buildSwitchAnchors(switchIds, switchAdj);
    Object.assign(anchors, switchAnchorResult.anchors);

    const switchAnchorValues = Object.values(switchAnchorResult.anchors);
    const center = switchAnchorValues.length > 0
        ? {
            x: mean(switchAnchorValues.map(point => point.x)),
            y: mean(switchAnchorValues.map(point => point.y))
        }
        : { x: 0, y: 0 };

    switchIds.forEach((switchId) => {
        const attachedHosts = (adjacency[switchId] || [])
            .filter((neighbor) => hostSet.has(neighbor))
            .sort(nodeSort);

        attachedHosts.forEach((hostId, index) => {
            const base = anchors[switchId] || { x: 0, y: 0 };
            let vx = base.x - center.x;
            let vy = base.y - center.y;
            if (Math.abs(vx) < 1 && Math.abs(vy) < 1) {
                vx = 0;
                vy = -1;
            }

            const magnitude = Math.hypot(vx, vy) || 1;
            const ux = vx / magnitude;
            const uy = vy / magnitude;
            const tx = -uy;
            const ty = ux;

            const side = index % 2 === 0 ? 1 : -1;
            const rank = Math.floor(index / 2);
            const radialDistance = 58 + rank * 16;
            const tangentialDistance = index === 0 ? 0 : 18 + rank * 16;

            anchors[hostId] = {
                x: base.x + (ux * radialDistance) + (tx * tangentialDistance * side),
                y: base.y + (uy * radialDistance) + (ty * tangentialDistance * side)
            };
        });
    });

    const externalIds = network.nodes
        .filter((node) => node.type === "external")
        .map((node) => node.id)
        .sort(nodeSort);
    const externalSet = new Set(externalIds);
    switchIds.forEach((switchId) => {
        const attachedExternal = (adjacency[switchId] || [])
            .filter((neighbor) => externalSet.has(neighbor))
            .sort(nodeSort);
        const base = anchors[switchId] || { x: 0, y: 0 };
        attachedExternal.forEach((externalId, index) => {
            anchors[externalId] = {
                x: base.x + 95,
                y: base.y + (index - (attachedExternal.length - 1) / 2) * 28
            };
        });
    });

    const unattachedHosts = hostIds.filter((hostId) => !anchors[hostId]);
    unattachedHosts.forEach((hostId, index) => {
        anchors[hostId] = {
            x: (index - (unattachedHosts.length - 1) / 2) * 90,
            y: (switchAnchorValues.length > 0 ? 180 : 0)
        };
    });

    return { anchors, layoutType: switchAnchorResult.layoutType };
}

const mean = values => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);

export function autoLayout(topology) {
  const nodes = [...topology.hosts.map(id => ({ id, type: 'host' })), ...Object.keys(topology.switches).map(id => ({ id, type: 'switch' }))];
  if (!nodes.length) return {};
  const { anchors } = buildTopologyAnchors({ nodes, links: topology.links.map(link => ({ source: link[0], target: link[1] })) });
  const xs = nodes.map(node => anchors[node.id]?.x || 0), ys = nodes.map(node => anchors[node.id]?.y || 0);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min(640 / (maxX - minX || 1), 260 / (maxY - minY || 1), 2);
  return Object.fromEntries(nodes.map(node => [node.id, { x: Math.round(400 + ((anchors[node.id]?.x || 0) - (minX + maxX) / 2) * scale), y: Math.round(200 + ((anchors[node.id]?.y || 0) - (minY + maxY) / 2) * scale) }]));
}
