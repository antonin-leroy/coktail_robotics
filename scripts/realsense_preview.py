"""Show RealSense RGB + depth side by side. Press q to quit.

Usage:  uv run scripts/realsense_preview.py
"""

import cv2
import numpy as np
import pyrealsense2 as rs

pipeline = rs.pipeline()
config = rs.config()
config.enable_stream(rs.stream.color, 640, 480, rs.format.bgr8, 30)
config.enable_stream(rs.stream.depth, 640, 480, rs.format.z16, 30)
pipeline.start(config)
align = rs.align(rs.stream.color)  # put depth pixels on top of the colour pixels

try:
    while True:
        frames = align.process(pipeline.wait_for_frames())
        rgb = np.asanyarray(frames.get_color_frame().get_data())
        depth = np.asanyarray(frames.get_depth_frame().get_data())  # uint16, millimetres

        depth_color = cv2.applyColorMap(cv2.convertScaleAbs(depth, alpha=255 / 2000), cv2.COLORMAP_JET)  # 0-2 m
        cv2.imshow("RealSense", np.hstack([rgb, depth_color]))
        if cv2.waitKey(1) == ord("q"):
            break
finally:
    pipeline.stop()
    cv2.destroyAllWindows()
