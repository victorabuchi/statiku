// swift-tools-version: 6.0
// Statiku for Mac, iPhone and iPad apps. It lives here beside the service for now and moves to its own public
// repository when it ships, since Swift Package Manager needs a package at the root of a repository.
import PackageDescription

let package = Package(
    name: "Statiku",
    platforms: [.macOS(.v12), .iOS(.v15), .tvOS(.v15), .watchOS(.v8), .visionOS(.v1)],
    products: [.library(name: "Statiku", targets: ["Statiku"])],
    targets: [
        .target(name: "Statiku"),
        .testTarget(name: "StatikuTests", dependencies: ["Statiku"]),
    ]
)
