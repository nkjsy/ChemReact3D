
import { Molecule } from '../types';

/**
 * Optimized 3D Force-Directed Graph Layout Simulation
 * 
 * Features:
 * - Aggressive 3D Scrambling: Detects linear/flat inputs and scatters them into a sphere to ensure 3D volume.
 * - VSEPR Approximation: Tuned Repulsion/Spring ratios to favor bond angles (tetrahedral, trigonal, etc).
 */
export const autoLayoutMolecule = (molecule: Molecule, width: number, height: number): Molecule => {
    if (!molecule.atoms || molecule.atoms.length === 0) return molecule;

    // --- Physics Constants ---
    // Increased repulsion to force atoms apart into 3D shapes
    const ITERATIONS = 600; // More iterations for stability
    const K_REPULSION = 80.0; 
    const K_SPRING = 0.5; // Softer springs allow repulsion to dictate geometry
    const DAMPING = 0.85;
    
    // Target Bond Lengths (Visual Units)
    const LENGTH_SINGLE = 3.5;
    const LENGTH_DOUBLE = 3.0;
    const LENGTH_TRIPLE = 2.5;

    // --- Initial State Analysis ---
    
    // Check if the input is effectively 2D or Linear (Z variance is low)
    const zValues = molecule.atoms.map(a => a.z || 0);
    const zMin = Math.min(...zValues);
    const zMax = Math.max(...zValues);
    const zRange = zMax - zMin;
    
    // If we have >2 atoms and the Z-depth is negligible, we are flat. 
    // We must break this symmetry aggressively.
    const needsScramble = molecule.atoms.length > 2 && zRange < 0.5;

    // Initialize simulation nodes
    const nodes = molecule.atoms.map((a, index) => {
        let x = a.x;
        let y = a.y;
        let z = a.z || 0;

        // AGGRESSIVE SCRAMBLE
        // If the molecule is flat/linear, project atoms onto a random sphere
        // This prevents the "Straight Line" local minimum problem.
        if (needsScramble) {
            // Golden Angle distribution for even spherical scattering
            const theta = index * 2.39996; // Golden angle in radians
            const y_sphere = 1 - (index / (molecule.atoms.length - 1)) * 2; // y goes from 1 to -1
            const radius_at_y = Math.sqrt(1 - y_sphere * y_sphere); 
            
            const radius = 5.0; // Initial explosion radius
            
            x = Math.cos(theta) * radius_at_y * radius;
            y = y_sphere * radius;
            z = Math.sin(theta) * radius_at_y * radius;
        } 
        // Always apply a micro-jitter to prevent exact numerical overlap
        else {
             x += (Math.random() - 0.5) * 0.2;
             y += (Math.random() - 0.5) * 0.2;
             z += (Math.random() - 0.5) * 0.2;
        }

        return {
            ...a,
            x, y, z,
            vx: 0, vy: 0, vz: 0,
            fx: 0, fy: 0, fz: 0
        };
    });

    // Map Edges
    const edges = molecule.bonds.map(b => {
        const sourceIdx = nodes.findIndex(n => n.id === b.sourceAtomId);
        const targetIdx = nodes.findIndex(n => n.id === b.targetAtomId);
        
        let targetLen = LENGTH_SINGLE;
        if (b.order === 2) targetLen = LENGTH_DOUBLE;
        if (b.order === 3) targetLen = LENGTH_TRIPLE;

        return { source: sourceIdx, target: targetIdx, len: targetLen };
    }).filter(e => e.source !== -1 && e.target !== -1);

    // --- Simulation Loop ---
    
    let temperature = 20.0;
    const coolingFactor = 0.95;

    for (let k = 0; k < ITERATIONS; k++) {
        // Reset forces
        for (let i = 0; i < nodes.length; i++) {
            nodes[i].fx = 0;
            nodes[i].fy = 0;
            nodes[i].fz = 0;
        }

        // 1. Repulsion (Inter-atomic)
        // Strong repulsion ensures atoms don't collapse into lines
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const n1 = nodes[i];
                const n2 = nodes[j];
                
                const dx = n1.x - n2.x;
                const dy = n1.y - n2.y;
                const dz = n1.z - n2.z;
                
                let distSq = dx*dx + dy*dy + dz*dz;
                if (distSq < 0.01) distSq = 0.01; 
                
                const dist = Math.sqrt(distSq);
                
                // Coulombic Repulsion
                const force = K_REPULSION / distSq;
                
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                const fz = (dz / dist) * force;

                n1.fx += fx;
                n1.fy += fy;
                n1.fz += fz;

                n2.fx -= fx;
                n2.fy -= fy;
                n2.fz -= fz;
            }
        }

        // 2. Attraction (Bonds)
        for (const edge of edges) {
            const n1 = nodes[edge.source];
            const n2 = nodes[edge.target];
            
            const dx = n2.x - n1.x;
            const dy = n2.y - n1.y;
            const dz = n2.z - n1.z;
            
            const dist = Math.sqrt(dx*dx + dy*dy + dz*dz) || 0.1;
            
            // Linear Spring
            const displacement = dist - edge.len;
            const force = K_SPRING * displacement;

            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            const fz = (dz / dist) * force;

            n1.fx += fx;
            n1.fy += fy;
            n1.fz += fz;

            n2.fx -= fx;
            n2.fy -= fy;
            n2.fz -= fz;
        }

        // 3. Gravity (Centering) - Keep it weak
        const GRAVITY = 0.01;
        for (const n of nodes) {
            n.fx -= n.x * GRAVITY;
            n.fy -= n.y * GRAVITY;
            n.fz -= n.z * GRAVITY;
        }

        // 4. Update Positions (Simulated Annealing)
        let maxVelSq = 0;
        
        for (const n of nodes) {
            n.vx = (n.vx + n.fx) * DAMPING;
            n.vy = (n.vy + n.fy) * DAMPING;
            n.vz = (n.vz + n.fz) * DAMPING;

            // Cap velocity
            const vSq = n.vx*n.vx + n.vy*n.vy + n.vz*n.vz;
            if (vSq > temperature * temperature) {
                const v = Math.sqrt(vSq);
                const scale = temperature / v;
                n.vx *= scale;
                n.vy *= scale;
                n.vz *= scale;
            }

            n.x += n.vx;
            n.y += n.vy;
            n.z += n.vz;
            
            if (vSq > maxVelSq) maxVelSq = vSq;
        }

        temperature *= coolingFactor;
        
        // Break if frozen
        if (temperature < 0.1 && maxVelSq < 0.01) break;
    }

    return {
        ...molecule,
        atoms: nodes.map(n => ({
            id: n.id,
            element: n.element,
            x: n.x,
            y: n.y,
            z: n.z
        })),
        bonds: molecule.bonds
    };
};
