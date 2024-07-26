import React, { useState, useRef, useEffect } from 'react';
import { useTopology } from '../../Contexts/TopologyContext';
import * as d3 from 'd3';
import './TopologyRenderer.css';

// TODO: error handling and assignment
export default function TopologyRenderer() {

    const svg_ref = useRef();
    const { loadedTopology } = useTopology();
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
        // Skip if no topology is loaded
        if (loadedTopology.length < 1) { return }
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
            .attr("id", (node) => { return node.id });

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
                .attr("x", (obj) => { return obj.x + icon_offset.host.x })
                .attr("y", (obj) => { return obj.y + icon_offset.host.y });

            // Set viewbox of SVG such that it scales correctly
            let bbox = svg.node().getBBox();
            svg.attr("viewBox", `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`);
        }


        var simulation = d3.forceSimulation(network.nodes)
            .force("link", d3.forceLink()
                .id((node) => { return node.id; })
                .links(network.links)
            )
            .force("charge", d3.forceManyBody().strength(-200))
            .on("tick", simTick)
            // TODO: if needed for frontend, this is called when simulation finishes
            .on("end", () => {
                network.nodes.forEach((node) => {
                    svg.append("text")
                        .text(node.id)
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
            <svg id="TopologyRender" ref={svg_ref} style={{height: 100 + "%" }}></svg>
        </div>
    )
}

function SwitchIcon() {
    return '<svg fill="#000000" width="15px" height="15px" viewBox="0 0 36 36" version="1.1" preserveAspectRatio="xMidYMid meet"> \
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