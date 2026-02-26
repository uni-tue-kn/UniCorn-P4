import React, { useState, useRef, useEffect } from 'react';
import { useTopology } from '../../../Contexts/TopologyContext';
import * as d3 from 'd3';
import './TopologyRenderer.css';

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
        const spacingX = 140;
        const spacingY = 120;
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
        const spacing = 120;
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
        const radius = Math.max(120, leaves.length * 26);
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
        const radius = Math.max(120, ordered.length * 24);
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
    const layerSpacingX = 150;
    const layerSpacingY = 110;
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
            x: d3.mean(switchAnchorValues, (p) => p.x) || 0,
            y: d3.mean(switchAnchorValues, (p) => p.y) || 0
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
            const radialDistance = 75 + rank * 18;
            const tangentialDistance = index === 0 ? 0 : 22 + rank * 18;

            anchors[hostId] = {
                x: base.x + (ux * radialDistance) + (tx * tangentialDistance * side),
                y: base.y + (uy * radialDistance) + (ty * tangentialDistance * side)
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

// TODO: error handling and assignment
export default function TopologyRenderer() {

    const svg_ref = useRef();
    const { loadedTopology, getLoadedTopology, loadTopologyByName } = useTopology();
    const [layoutedTopology, setLayoutedTopology] = useState({});

    const icon_offset = {
        host: {
            x: -5,
            y: -6
        },
        switch: {
            x: -5,
            y: -5
        }
    };

    function setupRender() {
        getLoadedTopology();

        // Skip if no topology is loaded
        if (loadedTopology.length < 1) {
            // Clear all
            // Get reference to SVG object
            const svg = d3.select(svg_ref.current)
                .attr('preserveAspectRatio', 'xMidYMid meet');

            // Ensure that the object is empty
            svg.selectAll("*").remove();
            return;
        }
        var topology = loadedTopology;

        // D3 requires an object with keys and values
        // So reshape data from loadedTopology to match this
        var network = {
            nodes: [],
            links: []
        }

        // Network needs to have a specific format
        // ALL nodes (switches, hosts) are located in one array and all links in another
        // Each node has two key value pairs, "type" and "id"
        // Each link has two key value pairs, "source" and "target" that match at the "id" of at least one node
        // The followign code flattens the original JSON into that structure
        topology.hosts.forEach(
            (host) => {
                network.nodes.push(
                    { "type": "host", "id": host }
                )
            });
        Object.keys(topology.switches).forEach(
            (switch_obj) => {
                network.nodes.push(
                    { "type": "switch", "id": switch_obj } // switch_obj because switch is a reserved keyword
                )
            });
        topology.links.forEach(
            (link_tuple) => {
                network.links.push(
                    { source: link_tuple[0], target: link_tuple[1] }
                )
            });
        const { anchors: anchorPositions } = buildTopologyAnchors(network);
        network.nodes.forEach((node) => {
            const anchor = anchorPositions[node.id];
            if (anchor) {
                node.x = anchor.x;
                node.y = anchor.y;
            }
        });

        // Get reference to SVG object
        const svg = d3.select(svg_ref.current)
            .attr('preserveAspectRatio', 'xMidYMid meet');

        // Ensure that the object is empty
        svg.selectAll("*").remove();

        // Create a node for each host
        const nodes = svg.selectAll("nodes")
            .data(network.nodes)
            .enter()
            .append("svg")
            // Set icon to either host or switch svg
            .html((node) => { return (node.type === "host" ? HostIcon() : SwitchIcon()) })
            .attr("id", (node) => { return node.id })
            .style("fill", "#666666");

        // Create links
        const links = svg.selectAll("links")
            .data(network.links)
            .enter()
            .append("line")
            .style("stroke", "#aaa")
            .lower();

        function simTick() {

            for (var i = 0; i < 100; i++) {
                simulation.tick();
            }
            links
                .attr("x1", function (d) { return d.source.x; })
                .attr("y1", function (d) { return d.source.y; })
                .attr("x2", function (d) { return d.target.x; })
                .attr("y2", function (d) { return d.target.y; });
            nodes
                // Add an offset in coordinates to all nodes to center the icon
                .attr("x", (obj) => { return obj.x + icon_offset[obj.type].x })
                .attr("y", (obj) => { return obj.y + icon_offset[obj.type].y });

            // Set viewbox of SVG such that it scales correctly
            let bbox = svg.node().getBBox();
            svg.attr("viewBox", `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`);
        }


        var simulation = d3.forceSimulation(network.nodes)
            .force("link", d3.forceLink()
                .id((node) => { return node.id; })
                .distance(80)
                .links(network.links)
            )
            .force("charge", d3.forceManyBody().strength(-400))
            .force("center", d3.forceCenter(0, 0))
            .force("collide", d3.forceCollide(20))
            .force("x", d3.forceX((node) => anchorPositions[node.id]?.x ?? 0).strength(0.35))
            .force("y", d3.forceY((node) => anchorPositions[node.id]?.y ?? 0).strength(0.45))
            .on("tick", simTick)
            // TODO: if needed for frontend, this is called when simulation finishes
            .on("end", () => {
                network.nodes.forEach((node) => {
                    svg.append("text")
                        .text(node.id)
                        .style("fill", "#666666")
                        .style("font-size", "0.4em")
                        .attr("x", node.x)
                        .attr("y", node.y - 8);
                    // Set viewbox of SVG such that it scales correctly
                    let bbox = svg.node().getBBox();
                    svg.attr("viewBox", `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`);
                })
                // Store topology layout to reload if necessary
                // TODO: implement loading from stored
                setLayoutedTopology(network);
            });
    }

    // Setup topology rendering once loadedTopology becomes available
    useEffect(setupRender, [loadedTopology]);

    // TODO: add loading animation
    return (
        <div id="TopologyContainer">
            <svg id="TopologyRender" ref={svg_ref} style={{ flexGrow: 1 }}> </svg>
        </div>
    )
}

function SwitchIcon() {
    return '<svg width="15px" height="15px" viewBox="0 0 36 36" version="1.1" preserveAspectRatio="xMidYMid meet"> \
            <path d="M33.91,18.47,30.78,8.41A2,2,0,0,0,28.87,7H7.13A2,2,0,0,0,5.22,8.41L2.09,18.48a2,2,0,0,0-.09.59V27a2,2,0,0,0,2,2H32a2,2,0,0,0,2-2V19.06A2,2,0,0,0,33.91,18.47ZM32,27H4V19.06L7.13,9H28.87L32,19.06Z" class="clr-i-outline clr-i-outline-path-1"></path><rect x="7.12" y="22" width="1.8" height="3" class="clr-i-outline clr-i-outline-path-2"></rect><rect x="12.12" y="22" width="1.8" height="3" class="clr-i-outline clr-i-outline-path-3"></rect><rect x="17.11" y="22" width="1.8" height="3" class="clr-i-outline clr-i-outline-path-4"></rect><rect x="22.1" y="22" width="1.8" height="3" class="clr-i-outline clr-i-outline-path-5"></rect><rect x="27.1" y="22" width="1.8" height="3" class="clr-i-outline clr-i-outline-path-6"></rect><rect x="6.23" y="18" width="23.69" height="1.4" class="clr-i-outline clr-i-outline-path-7"></rect> \
            <rect x="0" y="0" width="36" height="36" fill-opacity="0" /> \
        </svg>';
}

function HostIcon() {
    return '<svg width="15" height="15px" viewBox="0 0 24 24"> \
            <path d="M8,2h8a2,2,0,0,1,2,2V20a2,2,0,0,1-2,2H8a2,2,0,0,1-2-2V4A2,2,0,0,1,8,2M8,4V6h8V4H8m8,4H8v2h8V8m0,10H14v2h2Z" /> \
            <rect width="24" height="24" fill="none" /> \
        </svg>';
}
