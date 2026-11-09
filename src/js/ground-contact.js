/**
 * ground-contact.js - 体のいちばん低い点を探す(体を地面に接地させる機能のための計測)
 *
 * 立っているときは足裏、座っているときはお尻や足、寝ているときは背中や手が、床にいちばん近い。
 * そこで足に限らず、体のスキンメッシュ全体から、いちばん低い点を探す。
 * ただし髪やスカートなど揺れ物のボーンにウェイトのある頂点は、物理で動いて床に付くので、
 * 数えない(数えると、モデルの高さを調整したとたんに揺れて、また調整する、を繰り返してしまう)。
 *
 * 頂点は数万あるので、毎回全部は測れない。そこで 2 段階にする。
 * 1. あらかじめ、頂点を「主に影響するボーン(メッシュごと)」でグループに分け、グループごとに
 *    数十点だけ間引いて測る。
 * 2. 間引いた点で、いちばん低いグループと、それに近い(MARGIN 以内の)グループは、
 *    全頂点を測って、正確な最低点を求める。
 */
import * as THREE from "three";

const COARSE_PER_GROUP = 24; // 1 段階目で、グループごとに測る頂点の数(の目安)
const MARGIN = 0.03; // 間引きの誤差を見込んで、最低点からこの高さ(m)以内のグループは全頂点を測る
const KEEP_LOWEST = 8; // レストポーズでいちばん低い頂点は、間引かずに必ず残す(グループごと)

const _local = new THREE.Vector3();
const _world = new THREE.Vector3();

export class GroundContact {
  /** @param {import('@pixiv/three-vrm').VRM} vrm */
  constructor(vrm) {
    /** @type {{mesh: THREE.SkinnedMesh, all: number[], coarse: number[]}[]} */
    this._groups = [];
    this._build(vrm);
  }

  get groupCount() {
    return this._groups.length;
  }

  _build(vrm) {
    const springBones = new Set();
    for (const joint of vrm.springBoneManager?.joints ?? []) {
      springBones.add(joint.bone);
      if (joint.child) springBones.add(joint.child);
    }

    vrm.scene.updateMatrixWorld(true);
    vrm.scene.traverse((mesh) => {
      if (!mesh.isSkinnedMesh || !mesh.skeleton) return;
      const { skinIndex, skinWeight } = mesh.geometry.attributes;
      if (!skinIndex || !skinWeight) return;
      mesh.skeleton.update();
      /** @type {Map<number, {index:number, y:number}[]>} */
      const byBone = new Map();
      for (let i = 0; i < skinIndex.count; i++) {
        let best = 0;
        for (let k = 1; k < 4; k++) {
          if (
            skinWeight.getComponent(i, k) > skinWeight.getComponent(i, best)
          ) {
            best = k;
          }
        }
        const boneIndex = skinIndex.getComponent(i, best);
        if (springBones.has(mesh.skeleton.bones[boneIndex])) continue;
        mesh.getVertexPosition(i, _local);
        const y = _world.copy(_local).applyMatrix4(mesh.matrixWorld).y;
        let list = byBone.get(boneIndex);
        if (!list) byBone.set(boneIndex, list = []);
        list.push({ index: i, y });
      }
      for (const list of byBone.values()) {
        const stride = Math.max(1, Math.floor(list.length / COARSE_PER_GROUP));
        const coarse = new Set(
          [...list].sort((a, b) => a.y - b.y).slice(0, KEEP_LOWEST)
            .map((v) => v.index),
        );
        list.forEach((v, n) => {
          if (n % stride === 0) coarse.add(v.index);
        });
        this._groups.push({
          mesh,
          all: list.map((v) => v.index),
          coarse: [...coarse],
        });
      }
    });
  }

  /**
   * 今のポーズで、体のいちばん低い点の高さ(ワールド座標の y)。頂点が無ければ null。
   * 呼ぶ前に、ボーンのワールド行列を最新にしておくこと(vrm.scene.updateMatrixWorld)。
   */
  lowestY() {
    const updated = new Set();
    const lowestOf = (mesh, indices) => {
      if (!updated.has(mesh)) {
        mesh.skeleton.update();
        updated.add(mesh);
      }
      let lowest = Infinity;
      for (const index of indices) {
        mesh.getVertexPosition(index, _local);
        const y = _world.copy(_local).applyMatrix4(mesh.matrixWorld).y;
        if (y < lowest) lowest = y;
      }
      return lowest;
    };

    // 1 段階目: 間引いた点でグループごとの最低点を測る
    const coarse = this._groups.map((g) => lowestOf(g.mesh, g.coarse));
    const coarseLowest = Math.min(...coarse);
    if (!Number.isFinite(coarseLowest)) return null;

    // 2 段階目: いちばん低いグループとそれに近いグループは、全頂点を測って正確にする
    let lowest = Infinity;
    this._groups.forEach((g, n) => {
      if (coarse[n] > coarseLowest + MARGIN) return;
      lowest = Math.min(lowest, lowestOf(g.mesh, g.all));
    });
    return lowest;
  }
}
