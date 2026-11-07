// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "PipperLaunchIntro",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "pipper-launch-intro", targets: ["PipperLaunchIntro"]),
  ],
  targets: [
    .target(name: "LaunchIntroCore", path: "Sources/LaunchIntroCore"),
    .executableTarget(
      name: "PipperLaunchIntro",
      dependencies: ["LaunchIntroCore"],
      path: "Sources/PipperLaunchIntro"
    ),
    .testTarget(
      name: "LaunchIntroCoreTests",
      dependencies: ["LaunchIntroCore"],
      path: "Tests/LaunchIntroCoreTests"
    ),
  ]
)
