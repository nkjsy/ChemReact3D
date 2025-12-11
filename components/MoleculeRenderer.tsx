
import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { Canvas, useFrame, ThreeEvent, useThree } from '@react-three/fiber';
import { OrbitControls, Text, Html } from '@react-three/drei';
import * as THREE from 'three';
import { Molecule, AtomData, BondData } from '../types';
import { getElementStyle, ELEMENT_DATA_MAP } from '../constants';
import { ZoomIn, ZoomOut, Maximize, Loader2, Atom as AtomIcon } from 'lucide-react';
import { ThreeElements } from '@react-three/fiber';

// Augment the global JSX namespace with R3F elements to fix TS errors in XML output
declare global {
  namespace JSX {
    interface IntrinsicElements extends ThreeElements {}
  }
}

interface MoleculeRendererProps {
  molecule: Molecule;
  width?: number | string;
  height?: number | string;
  interactive?: boolean;
  onUpdate?: (molecule: Molecule) => void;
  isAutoLayout?: boolean;
  mode?: 'build' | 'erase';
  onAtomDelete?: (atomId: string) => void;
  onBondDelete?: (bondId: string) => void;
  showControls?: boolean;
  showMoleculeName?: boolean;
  autoFit?: boolean;
}

// --- 3D Components ---

const AtomMesh: React.FC<{
  atom: AtomData;
  isSelected: boolean;
  isHovered: boolean;
  mode: string;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
  onPointerDown: (e: ThreeEvent<PointerEvent>) => void;
  onPointerOver: (e: ThreeEvent<PointerEvent>) => void;
  onPointerOut: (e: ThreeEvent<PointerEvent>) => void;
}> = ({ atom, isSelected, isHovered, mode, onClick, onPointerDown, onPointerOver, onPointerOut }) => {
  const style = useMemo(() => getElementStyle(atom.element), [atom.element]);
  const color = style.bg;
  const radius = (style.radius || 20) / 40; // Scale down for 3D world space (approx 0.5 - 1.0 units)

  return (
    <group position={[atom.x, atom.y, atom.z || 0]}>
      <mesh 
        onClick={onClick} 
        onPointerDown={onPointerDown}
        onPointerOver={onPointerOver}
        onPointerOut={onPointerOut}
      >
        <sphereGeometry args={[radius, 32, 32]} />
        <meshStandardMaterial 
            color={mode === 'erase' && isHovered ? '#ef4444' : color} 
            emissive={isSelected ? '#4f46e5' : '#000000'}
            emissiveIntensity={isSelected ? 0.5 : 0}
            roughness={0.3}
            metalness={0.2}
        />
      </mesh>
      <Text
        position={[0, 0, radius + 0.05]}
        fontSize={radius * 0.8}
        color={style.text}
        anchorX="center"
        anchorY="middle"
        font="https://fonts.gstatic.com/s/inter/v12/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hjp-Ek-_EeA.woff"
      >
        {atom.element}
      </Text>
    </group>
  );
};

const BondMesh: React.FC<{
  bond: BondData;
  atoms: AtomData[];
  mode: string;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
}> = ({ bond, atoms, mode, onClick }) => {
  const source = atoms.find(a => a.id === bond.sourceAtomId);
  const target = atoms.find(a => a.id === bond.targetAtomId);
  const [hovered, setHovered] = useState(false);

  if (!source || !target) return null;

  const start = new THREE.Vector3(source.x, source.y, source.z || 0);
  const end = new THREE.Vector3(target.x, target.y, target.z || 0);
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  
  // Midpoint
  const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
  
  // Orientation using quaternion
  const quaternion = new THREE.Quaternion();
  const defaultUp = new THREE.Vector3(0, 1, 0); // Cylinders default to Y-axis
  quaternion.setFromUnitVectors(defaultUp, direction.clone().normalize());

  // Configuration for bond types
  const baseRadius = 0.12;
  const separation = 0.25;

  // Calculate a consistent perpendicular vector for multi-bond offsets
  const axis = direction.clone().normalize();
  let up = new THREE.Vector3(0, 0, 1);
  // If bond is nearly vertical (Z-aligned), use X as up vector to avoid instability
  if (Math.abs(axis.dot(up)) > 0.9) up.set(1, 0, 0);
  
  const perp = new THREE.Vector3().crossVectors(axis, up).normalize().multiplyScalar(separation);

  const handlePointerOver = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHovered(true);
  };

  const handlePointerOut = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHovered(false);
  };

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onClick(e);
  };

  const materialProps = {
    color: mode === 'erase' && hovered ? '#ef4444' : "#94a3b8",
    roughness: 0.4,
    metalness: 0.3
  };

  const CylinderSegment = ({ position, radius }: { position: THREE.Vector3, radius: number }) => (
    <mesh position={position} quaternion={quaternion}>
      <cylinderGeometry args={[radius, radius, length, 12]} />
      <meshStandardMaterial {...materialProps} />
    </mesh>
  );

  if (bond.order === 3) {
    return (
      <group onPointerOver={handlePointerOver} onPointerOut={handlePointerOut} onClick={handleClick}>
        <CylinderSegment position={mid} radius={baseRadius * 0.8} />
        <CylinderSegment position={mid.clone().add(perp)} radius={baseRadius * 0.8} />
        <CylinderSegment position={mid.clone().sub(perp)} radius={baseRadius * 0.8} />
      </group>
    );
  } 
  
  if (bond.order === 2) {
    const offsetHalf = perp.clone().multiplyScalar(0.6);
    return (
      <group onPointerOver={handlePointerOver} onPointerOut={handlePointerOut} onClick={handleClick}>
         <CylinderSegment position={mid.clone().add(offsetHalf)} radius={baseRadius * 0.9} />
         <CylinderSegment position={mid.clone().sub(offsetHalf)} radius={baseRadius * 0.9} />
      </group>
    );
  }

  // Single Bond
  return (
     <group onPointerOver={handlePointerOver} onPointerOut={handlePointerOut} onClick={handleClick}>
       <CylinderSegment position={mid} radius={baseRadius} />
     </group>
  );
};

// --- AutoFit Component ---
const AutoFitManager: React.FC<{ 
  molecule: Molecule; 
  autoFit: boolean; 
  orbitControlsRef: React.MutableRefObject<any>;
}> = ({ molecule, autoFit, orbitControlsRef }) => {
  const { camera } = useThree();
  const firstRender = useRef(true);
  const prevAtomCount = useRef(molecule.atoms.length);

  useEffect(() => {
    if (molecule.atoms.length === 0) return;

    const shouldFit = autoFit || firstRender.current || (autoFit && molecule.atoms.length !== prevAtomCount.current);

    if (shouldFit) {
      firstRender.current = false;
      prevAtomCount.current = molecule.atoms.length;

      const points = molecule.atoms.map(a => new THREE.Vector3(a.x, a.y, a.z || 0));
      const box = new THREE.Box3().setFromPoints(points);
      
      const center = new THREE.Vector3();
      box.getCenter(center);
      
      const size = new THREE.Vector3();
      box.getSize(size);
      
      const maxDim = Math.max(size.x, size.y, size.z, 5); // Minimum size 5 to prevent zoom-in too much on single atoms
      const fov = 50;
      const cameraZ = Math.abs(maxDim / 2 / Math.tan(fov * Math.PI / 360)) * 1.5; // 1.5 padding factor
      
      // We animate the controls target to center
      if (orbitControlsRef.current) {
         orbitControlsRef.current.target.lerp(center, 0.5); // Smoothly move target
         
         // If hard reset is needed (like initial load), set directly
         if (firstRender.current) {
            orbitControlsRef.current.target.copy(center);
            camera.position.set(center.x, center.y, center.z + cameraZ);
            camera.lookAt(center);
         } else {
             // For updates, we might just want to ensure we aren't miles away
             // But usually orbit controls handles user interaction, so we don't force camera pos unless strict autoFit
             if (autoFit) {
                // If strictly auto-fitting (e.g. preview), reset camera
                camera.position.set(center.x, center.y, center.z + cameraZ);
                camera.lookAt(center);
             }
         }
      }
    }
  }, [molecule, autoFit, camera, orbitControlsRef]);

  return null;
};

// --- Main Scene Content ---

const SceneContent: React.FC<{
    molecule: Molecule;
    interactive: boolean;
    mode: string;
    onAtomUpdate: (atomId: string, pos: THREE.Vector3) => void;
    onAtomClick: (atomId: string) => void;
    onBondClick: (bondId: string) => void;
    selectedAtomId: string | null;
    setHoveredAtomId: (id: string | null) => void;
    orbitEnabled: boolean;
    setOrbitEnabled: (enabled: boolean) => void;
}> = ({ 
    molecule, interactive, mode, onAtomUpdate, onAtomClick, onBondClick, 
    selectedAtomId, setHoveredAtomId, orbitEnabled, setOrbitEnabled 
}) => {
    const { camera, gl } = useThree();
    const draggingIdRef = useRef<string | null>(null);
    const dragPlane = useRef(new THREE.Plane());
    const dragOffset = useRef(new THREE.Vector3());

    // Refs to hold latest values for the event listener closure
    const cameraRef = useRef(camera);
    const glRef = useRef(gl);
    const onAtomUpdateRef = useRef(onAtomUpdate);
    
    // Update refs when props/state change
    useEffect(() => { cameraRef.current = camera; }, [camera]);
    useEffect(() => { glRef.current = gl; }, [gl]);
    useEffect(() => { onAtomUpdateRef.current = onAtomUpdate; }, [onAtomUpdate]);

    const onGlobalPointerMove = useCallback((event: PointerEvent) => {
        if (!draggingIdRef.current) return;
        
        const canvasElement = glRef.current.domElement;
        const rect = canvasElement.getBoundingClientRect();
        
        // Convert mouse position to Normalized Device Coordinates (-1 to +1)
        const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(x, y), cameraRef.current);
        
        const intersectPoint = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(dragPlane.current, intersectPoint)) {
             const newPos = new THREE.Vector3().addVectors(intersectPoint, dragOffset.current);
             onAtomUpdateRef.current(draggingIdRef.current, newPos);
        }
    }, []);

    const onGlobalPointerUp = useCallback((event: PointerEvent) => {
        draggingIdRef.current = null;
        setOrbitEnabled(true);
        window.removeEventListener('pointermove', onGlobalPointerMove);
        window.removeEventListener('pointerup', onGlobalPointerUp);
        // Release pointer capture if it was set on the canvas
        if (glRef.current.domElement.hasPointerCapture(event.pointerId)) {
             glRef.current.domElement.releasePointerCapture(event.pointerId);
        }
    }, [onGlobalPointerMove, setOrbitEnabled]);

    const handlePointerDown = (e: ThreeEvent<PointerEvent>, atomId: string) => {
        if (!interactive || mode === 'erase') return;
        e.stopPropagation();
        
        const atom = molecule.atoms.find(a => a.id === atomId);
        if (!atom) return;
        
        const atomPos = new THREE.Vector3(atom.x, atom.y, atom.z || 0);
        draggingIdRef.current = atomId;
        
        const normal = new THREE.Vector3();
        camera.getWorldDirection(normal);
        dragPlane.current.setFromNormalAndCoplanarPoint(normal, atomPos);
        
        const intersectPoint = new THREE.Vector3();
        e.ray.intersectPlane(dragPlane.current, intersectPoint);
        
        if (intersectPoint) {
            dragOffset.current.subVectors(atomPos, intersectPoint);
        }
        
        setOrbitEnabled(false);
        window.addEventListener('pointermove', onGlobalPointerMove);
        window.addEventListener('pointerup', onGlobalPointerUp);
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
    };

    // Clean up listeners on unmount
    useEffect(() => {
        return () => {
            window.removeEventListener('pointermove', onGlobalPointerMove);
            window.removeEventListener('pointerup', onGlobalPointerUp);
        };
    }, [onGlobalPointerMove, onGlobalPointerUp]);

    return (
        <group>
            {molecule.atoms.map(atom => (
                <AtomMesh 
                    key={atom.id} 
                    atom={atom} 
                    isSelected={selectedAtomId === atom.id}
                    isHovered={false} 
                    mode={mode}
                    onClick={(e) => { 
                        if (!draggingIdRef.current) {
                           e.stopPropagation(); 
                           onAtomClick(atom.id); 
                        }
                    }}
                    onPointerDown={(e) => handlePointerDown(e, atom.id)}
                    onPointerOver={(e) => { e.stopPropagation(); setHoveredAtomId(atom.id); }}
                    onPointerOut={(e) => { e.stopPropagation(); setHoveredAtomId(null); }}
                />
            ))}
            {molecule.bonds.map(bond => (
                <BondMesh 
                    key={bond.id} 
                    bond={bond} 
                    atoms={molecule.atoms} 
                    mode={mode}
                    onClick={(e) => { 
                        // Note: BondMesh now handles stopPropagation internally in its handlers
                        onBondClick(bond.id); 
                    }}
                />
            ))}
        </group>
    );
}


// --- Main Wrapper ---

const MoleculeRenderer: React.FC<MoleculeRendererProps> = ({
  molecule,
  width = '100%',
  height = '100%',
  interactive = false,
  onUpdate,
  mode = 'build',
  onAtomDelete,
  onBondDelete,
  showControls = true,
  showMoleculeName = true,
  autoFit = false,
  isAutoLayout = false // Not actively used inside R3F loop here, usually handled by parent
}) => {
  const [internalMolecule, setInternalMolecule] = useState<Molecule>(molecule);
  const [selectedAtomId, setSelectedAtomId] = useState<string | null>(null);
  const [hoveredAtomId, setHoveredAtomId] = useState<string | null>(null);
  const [orbitEnabled, setOrbitEnabled] = useState(true);
  const orbitControlsRef = useRef<any>(null);

  // Sync internal state
  useEffect(() => {
    setInternalMolecule(molecule);
  }, [molecule]);

  const handleAtomUpdate = (atomId: string, pos: THREE.Vector3) => {
     if (!onUpdate) return;
     const newAtoms = internalMolecule.atoms.map(a => 
        a.id === atomId ? { ...a, x: pos.x, y: pos.y, z: pos.z } : a
     );
     const updated = { ...internalMolecule, atoms: newAtoms };
     setInternalMolecule(updated);
     onUpdate(updated);
  };

  const handleAtomClick = (atomId: string) => {
    if (!interactive) return;

    if (mode === 'erase') {
       if (onAtomDelete) onAtomDelete(atomId);
       return;
    }

    if (selectedAtomId && selectedAtomId !== atomId) {
        // Create/Modify Bond
        const existingBondIndex = internalMolecule.bonds.findIndex(b => 
            (b.sourceAtomId === selectedAtomId && b.targetAtomId === atomId) ||
            (b.targetAtomId === selectedAtomId && b.sourceAtomId === atomId)
        );

        if (existingBondIndex >= 0) {
            // Cycle Order
            const bond = internalMolecule.bonds[existingBondIndex];
            const newOrder = bond.order === 1 ? 2 : (bond.order === 2 ? 3 : 1);
            const updatedBonds = [...internalMolecule.bonds];
            updatedBonds[existingBondIndex] = { ...bond, order: newOrder as 1|2|3 };
            const updated = { ...internalMolecule, bonds: updatedBonds };
            setInternalMolecule(updated);
            if (onUpdate) onUpdate(updated);
        } else {
            // New Bond
            const newBond: BondData = {
                id: `bond-${Date.now()}`,
                sourceAtomId: selectedAtomId,
                targetAtomId: atomId,
                order: 1
            };
            const updated = { ...internalMolecule, bonds: [...internalMolecule.bonds, newBond] };
            setInternalMolecule(updated);
            if (onUpdate) onUpdate(updated);
        }
        setSelectedAtomId(null); // Deselect after action
    } else {
        setSelectedAtomId(selectedAtomId === atomId ? null : atomId);
    }
  };

  const handleBondClick = (bondId: string) => {
      if (!interactive) return;
      if (mode === 'erase' && onBondDelete) {
          onBondDelete(bondId);
      }
  };

  // Tooltip Logic
  const hoveredAtomData = useMemo(() => {
     if (!hoveredAtomId) return null;
     const atom = internalMolecule.atoms.find(a => a.id === hoveredAtomId);
     if (!atom) return null;
     return { atom, def: ELEMENT_DATA_MAP[atom.element] };
  }, [hoveredAtomId, internalMolecule]);

  return (
    <div className="relative rounded-lg overflow-hidden bg-slate-50 border border-slate-200" style={{ width, height }}>
        {internalMolecule.atoms.length === 0 && (
             <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 pointer-events-none z-10">
                <AtomIcon size={48} className="mb-3 text-slate-300" />
                <p className="text-sm font-medium">Empty 3D Workspace</p>
             </div>
        )}

        <Canvas camera={{ position: [0, 0, 15], fov: 50 }}>
            <ambientLight intensity={0.6} />
            <pointLight position={[10, 10, 10]} intensity={1.5} />
            <pointLight position={[-10, -10, -10]} intensity={0.5} />
            
            <SceneContent 
                molecule={internalMolecule}
                interactive={interactive}
                mode={mode}
                onAtomUpdate={handleAtomUpdate}
                onAtomClick={handleAtomClick}
                onBondClick={handleBondClick}
                selectedAtomId={selectedAtomId}
                setHoveredAtomId={setHoveredAtomId}
                orbitEnabled={orbitEnabled}
                setOrbitEnabled={setOrbitEnabled}
            />

            <AutoFitManager 
                molecule={internalMolecule} 
                autoFit={autoFit} 
                orbitControlsRef={orbitControlsRef} 
            />

            <OrbitControls 
                ref={orbitControlsRef}
                enabled={orbitEnabled} 
                enablePan={true} 
                enableZoom={true} 
                makeDefault
            />
        </Canvas>

        {/* HUD Controls */}
        {showControls && (
            <div className="absolute bottom-4 right-4 z-10 flex flex-col gap-1 bg-white/90 p-1 rounded-lg shadow border border-slate-200">
               {/* Controls handled natively by OrbitControls, these could be custom triggers or removed */}
               <div className="text-[10px] text-slate-400 text-center px-1">Rotate / Zoom</div>
            </div>
        )}

        {/* Tooltip Overlay */}
        {hoveredAtomData && (
             <div className="absolute top-4 right-4 z-20 pointer-events-none w-48 p-3 bg-slate-900/90 text-white text-xs rounded-lg shadow-xl backdrop-blur-sm border border-slate-700 animate-in fade-in zoom-in-95 duration-100">
                <div className="flex items-center justify-between border-b border-slate-600 pb-2 mb-2">
                   <span className="font-bold text-sm">{hoveredAtomData.def.name}</span>
                   <span className="font-mono text-lg font-bold text-slate-400">{hoveredAtomData.atom.element}</span>
                </div>
                <div className="space-y-1">
                   <div className="flex justify-between">
                     <span className="text-slate-400">Atomic No.</span>
                     <span className="font-mono">{hoveredAtomData.def.atomicNumber}</span>
                   </div>
                   <div className="flex justify-between">
                     <span className="text-slate-400">Mass</span>
                     <span className="font-mono">{hoveredAtomData.def.mass}</span>
                   </div>
                   <div className="flex justify-between">
                     <span className="text-slate-400">Pos</span>
                     <span className="font-mono opacity-70">
                        {hoveredAtomData.atom.x.toFixed(1)}, {hoveredAtomData.atom.y.toFixed(1)}, {(hoveredAtomData.atom.z || 0).toFixed(1)}
                     </span>
                   </div>
                </div>
             </div>
        )}

        {!interactive && showMoleculeName && (
            <div className="absolute bottom-4 left-4 z-30 px-2 py-1 bg-white/80 backdrop-blur rounded text-xs text-slate-500 font-mono pointer-events-none border border-slate-100">
            {internalMolecule.name || 'Untitled'}
            </div>
        )}
    </div>
  );
};

export default MoleculeRenderer;
