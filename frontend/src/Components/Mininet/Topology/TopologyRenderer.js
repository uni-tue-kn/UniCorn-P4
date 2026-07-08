import React, { useState, useRef, useEffect } from 'react';
import { useTopology } from '../../../Contexts/TopologyContext';
import { useTheme as useAppTheme } from '../../../Contexts/ThemeContext';
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

function normalizeTopologyLink(link) {
    if (Array.isArray(link)) {
        return { source: link[0], target: link[1] };
    }
    return { source: link.node1, target: link.node2 };
}

function interfacePairKey(nodeA, nodeB) {
    return [nodeA, nodeB].sort(nodeSort).join("::");
}

function formatInterfaceEndpoint(entry) {
    return `${entry.node}:${entry.port} ${entry.interface}`;
}

function formatPortLabel(entry) {
    return `${entry.node}:${entry.port}`;
}

function buildInterfaceDetails(interfaceMapping) {
    const virtualEntries = {};
    const externalLinks = [];

    Object.values(interfaceMapping || {}).forEach((entries) => {
        (entries || []).forEach((entry) => {
            if (entry.type === "external") {
                const externalNodeId = `external:${entry.node}:${entry.port}:${entry.interface}`;
                externalLinks.push({
                    node: {
                        type: "external",
                        id: externalNodeId,
                        label: entry.interface,
                        title: `${formatInterfaceEndpoint(entry)} <-> external`,
                        portLabel: formatPortLabel(entry)
                    },
                    link: {
                        source: entry.node,
                        target: externalNodeId,
                        type: "external",
                        title: `${formatInterfaceEndpoint(entry)} <-> external`,
                        sourcePortLabel: formatPortLabel(entry),
                        targetPortLabel: ""
                    }
                });
                return;
            }

            if (!entry.peer_node) {
                return;
            }

            const key = interfacePairKey(entry.node, entry.peer_node);
            virtualEntries[key] = virtualEntries[key] || [];
            virtualEntries[key].push(entry);
        });
    });

    const titlesByPair = {};
    const portsByPair = {};
    Object.entries(virtualEntries).forEach(([key, entries]) => {
        const first = entries[0];
        const peer = entries.find((entry) => entry.node === first.peer_node);
        if (peer) {
            titlesByPair[key] = `${formatInterfaceEndpoint(first)} <-> ${formatInterfaceEndpoint(peer)}`;
            portsByPair[key] = {
                [first.node]: formatPortLabel(first),
                [peer.node]: formatPortLabel(peer)
            };
        } else {
            titlesByPair[key] = `${formatInterfaceEndpoint(first)} <-> ${first.peer_node} ${first.peer_interface}`;
            portsByPair[key] = {
                [first.node]: formatPortLabel(first)
            };
        }
    });

    return { titlesByPair, portsByPair, externalLinks };
}

const ICON_OFFSET = {
    host: {
        x: -5,
        y: -6
    },
    switch: {
        x: -5,
        y: -5
    },
    external: {
        x: -4,
        y: -4
    }
};
const VIEWBOX_PADDING = 32;
const MAX_TOPOLOGY_SCALE = 2.65;
const PORT_LABEL_DISTANCE = 28;
const PORT_LABEL_VERTICAL_OFFSET = -5;
const PORT_LABEL_TANGENT_OFFSET = 8;

// TODO: error handling and assignment
export default function TopologyRenderer() {

    const svg_ref = useRef();
    const simulation_ref = useRef(null);
    const { loadedTopology } = useTopology();
    const { darkMode } = useAppTheme();
    const [, setLayoutedTopology] = useState({});

    function setupRender() {
        if (simulation_ref.current) {
            simulation_ref.current.stop();
            simulation_ref.current = null;
        }

        // Skip if no topology is loaded
        if (!loadedTopology || Object.keys(loadedTopology).length < 1) {
            // Clear all
            // Get reference to SVG object
            const svg = d3.select(svg_ref.current)
                .attr('preserveAspectRatio', 'xMidYMid meet');

            // Ensure that the object is empty
            svg.selectAll("*").remove();
            svg.attr("width", null).attr("height", null).attr("viewBox", null);
            return;
        }
        var topology = loadedTopology;
        const { titlesByPair, portsByPair, externalLinks } = buildInterfaceDetails(topology.interface_mapping);

        // D3 requires an object with keys and values
        // So reshape data from loadedTopology to match this
        var network = {
            nodes: [],
            links: []
        };

        // Network needs to have a specific format
        // ALL nodes (switches, hosts) are located in one array and all links in another
        // Each node has two key value pairs, "type" and "id"
        // Each link has two key value pairs, "source" and "target" that match at the "id" of at least one node
        // The followign code flattens the original JSON into that structure
        (topology.hosts || []).forEach(
            (host) => {
                network.nodes.push(
                    { "type": "host", "id": host }
                );
            });
        Object.keys(topology.switches || {}).forEach(
            (switch_obj) => {
                network.nodes.push(
                    { "type": "switch", "id": switch_obj } // switch_obj because switch is a reserved keyword
                );
            });
        (topology.links || []).forEach(
            (link) => {
                const normalizedLink = normalizeTopologyLink(link);
                const linkKey = interfacePairKey(normalizedLink.source, normalizedLink.target);
                const title = titlesByPair[linkKey];
                const portLabels = portsByPair[linkKey] || {};
                network.links.push({
                    ...normalizedLink,
                    type: "virtual",
                    title,
                    sourcePortLabel: portLabels[normalizedLink.source] || "",
                    targetPortLabel: portLabels[normalizedLink.target] || ""
                });
            });
        externalLinks.forEach((externalLink) => {
            network.nodes.push(externalLink.node);
            network.links.push(externalLink.link);
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

        function updateSvgViewport() {
            const bbox = svg.node().getBBox();
            if (bbox.width < 1 || bbox.height < 1) {
                return;
            }

            const containerWidth = svg_ref.current?.parentElement?.clientWidth || 0;
            const containerHeight = svg_ref.current?.parentElement?.clientHeight || 0;
            const containerAspect = containerWidth > 0 && containerHeight > 0
                ? containerWidth / containerHeight
                : 1;
            const contentBox = {
                x: bbox.x - VIEWBOX_PADDING,
                y: bbox.y - VIEWBOX_PADDING,
                width: bbox.width + (VIEWBOX_PADDING * 2),
                height: bbox.height + (VIEWBOX_PADDING * 2)
            };
            const center = {
                x: contentBox.x + (contentBox.width / 2),
                y: contentBox.y + (contentBox.height / 2)
            };
            const fittedViewBox = { ...contentBox };

            if (fittedViewBox.width / fittedViewBox.height > containerAspect) {
                fittedViewBox.height = fittedViewBox.width / containerAspect;
            } else {
                fittedViewBox.width = fittedViewBox.height * containerAspect;
            }

            if (containerWidth > 0 && containerHeight > 0) {
                const minWidth = containerWidth / MAX_TOPOLOGY_SCALE;
                const minHeight = containerHeight / MAX_TOPOLOGY_SCALE;

                if (fittedViewBox.width < minWidth) {
                    fittedViewBox.width = minWidth;
                    fittedViewBox.height = fittedViewBox.width / containerAspect;
                }

                if (fittedViewBox.height < minHeight) {
                    fittedViewBox.height = minHeight;
                    fittedViewBox.width = fittedViewBox.height * containerAspect;
                }
            }

            fittedViewBox.x = center.x - (fittedViewBox.width / 2);
            fittedViewBox.y = center.y - (fittedViewBox.height / 2);

            svg
                .attr("viewBox", `${fittedViewBox.x} ${fittedViewBox.y} ${fittedViewBox.width} ${fittedViewBox.height}`)
                .attr("width", "100%")
                .attr("height", "100%");
        }

        // Create a node for each host
        const nodes = svg.selectAll("nodes")
            .data(network.nodes)
            .enter()
            .append("svg")
            // Set icon to either host or switch svg
            .html((node) => {
                if (node.type === "host") {
                    return HostIcon();
                }
                if (node.type === "external") {
                    return ExternalIcon();
                }
                return SwitchIcon();
            })
            .attr("id", (node) => { return node.id })
            .attr("class", (node) => { return node.type === "external" ? "topology-node topology-node-external" : "topology-node"; });
        nodes.append("title")
            .text((node) => { return node.title || node.id; });

        // Create links
        const links = svg.selectAll("links")
            .data(network.links)
            .enter()
            .append("line")
            .attr("class", (link) => { return link.type === "external" ? "topology-link topology-link-external" : "topology-link"; })
            .style("stroke-dasharray", (link) => { return link.type === "external" ? "4 3" : null; })
            .lower();
        links.append("title")
            .text((link) => { return link.title || `${link.source} <-> ${link.target}`; });
        const sourcePortLabels = svg.selectAll("sourcePortLabels")
            .data(network.links.filter((link) => link.sourcePortLabel))
            .enter()
            .append("text")
            .attr("class", "topology-port-label")
            .text((link) => link.sourcePortLabel);
        const targetPortLabels = svg.selectAll("targetPortLabels")
            .data(network.links.filter((link) => link.targetPortLabel))
            .enter()
            .append("text")
            .attr("class", "topology-port-label")
            .text((link) => link.targetPortLabel);

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
                .attr("x", (obj) => { return obj.x + ICON_OFFSET[obj.type].x })
                .attr("y", (obj) => { return obj.y + ICON_OFFSET[obj.type].y });
            const portLabelPosition = (d, endpoint) => {
                const source = d.source;
                const target = d.target;
                const node = endpoint === "source" ? source : target;
                const other = endpoint === "source" ? target : source;
                const dx = other.x - node.x;
                const dy = other.y - node.y;
                const distance = Math.hypot(dx, dy) || 1;
                const tangentDirection = endpoint === "source" ? 1 : -1;
                return {
                    x: node.x + (dx / distance) * PORT_LABEL_DISTANCE + (-dy / distance) * PORT_LABEL_TANGENT_OFFSET * tangentDirection,
                    y: node.y + (dy / distance) * PORT_LABEL_DISTANCE + (dx / distance) * PORT_LABEL_TANGENT_OFFSET * tangentDirection + PORT_LABEL_VERTICAL_OFFSET
                };
            };
            sourcePortLabels
                .attr("x", (d) => portLabelPosition(d, "source").x)
                .attr("y", (d) => portLabelPosition(d, "source").y);
            targetPortLabels
                .attr("x", (d) => portLabelPosition(d, "target").x)
                .attr("y", (d) => portLabelPosition(d, "target").y);

            // Set viewbox of SVG such that it scales correctly
            updateSvgViewport();
        }


        var simulation = d3.forceSimulation(network.nodes)
            .force("link", d3.forceLink()
                .id((node) => { return node.id; })
                .distance(64)
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
                        .attr("class", "topology-node-label")
                        .text(node.label || node.id)
                        .style("font-weight", node.type === "external" ? "600" : "400")
                        .attr("x", node.x)
                        .attr("y", node.y - 12);
                    // Set viewbox of SVG such that it scales correctly
                    updateSvgViewport();
                })
                // Store topology layout to reload if necessary
                // TODO: implement loading from stored
                setLayoutedTopology(network);
            });
        simulation_ref.current = simulation;

        return () => {
            simulation.stop();
            if (simulation_ref.current === simulation) {
                simulation_ref.current = null;
            }
        };
    }

    // Setup topology rendering once loadedTopology becomes available
    useEffect(setupRender, [loadedTopology]);

    // TODO: add loading animation
    return (
        <div id="TopologyContainer" className={darkMode ? "topology-dark" : "topology-light"}>
            <svg id="TopologyRender" ref={svg_ref}> </svg>
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

function ExternalIcon() {
    return '<svg width="12" height="12" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="2" fill="#ffffff" /></svg>';
}
