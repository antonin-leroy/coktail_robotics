# Cocktail Robotics

Bimanual OpenArm (Enactic, v10) that grasps a bottle and a glass, stops in a fixed
"handoff" pose, then a separate scripted skill pours. Partner does teleoperation
(leader arms → follower). Data will be LeRobotDataset v3; first policy will be ACT.

## Hardware
- Leader: OpenArm Mini (Feetech servos). Its calibration lives in
  `calibration/teleoperators/openarm_mini/` and matches offsets stored in the servos:
  do not re-run `lerobot-calibrate` on the leader (see README).
- Follower: 2 × 7-DOF arms + gripper, Damiao motors. Per arm: joint_1-2 DM8009,
  joint_3-4 DM4340, joint_5-7 DM4310, gripper DM4310. Send IDs 0x01-0x08, feedback 0x11-0x18.
- CAN: PEAK PCAN-USB Pro FD (2 channels, one arm each), CAN FD 1 Mbps / 5 Mbps, sample point 0.75.
- On macOS only CAN1 works (PCBUSB driver limit), so robot work happens in the Ubuntu VM
  (UTM/QEMU, aarch64, USB passthrough, `peak_usb` → `can0`, `can1`).

## Code
- Environment: `uv sync` (Python 3.12, LeRobot pinned to a tested commit in `pyproject.toml`).
  Run tools with `uv run`, e.g. `uv run lerobot-calibrate ...`.
- `scripts/realsense_preview.py`: RealSense D455 RGB + depth preview with OpenCV.
  `opencv-python-headless` (from LeRobot) is overridden in `pyproject.toml` so `cv2.imshow` works.
- `lerobot-setup-can --mode=test` is NOT read-only (sends enable to every motor).
- Preferred stack for real use: LeRobot `openarm_follower` / `bi_openarm_follower` with socketcan.

## Safety rules (from the user)
- Never command motion or enable torque without the user's explicit go for that specific step.
- Read-only checks first; any motion: one joint at a time, a few degrees, slow, return to start.
- Zero calibration overwrites the motors' zero and affects the partner's teleop/data: confirm first.
- Interactive steps that need hands on the robot (calibration) are run by the user.

## Conventions
- No Claude attribution (no Co-Authored-By) in commits or PRs.
