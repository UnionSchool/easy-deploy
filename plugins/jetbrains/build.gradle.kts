plugins {
    kotlin("jvm") version "1.9.25"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "com.unionschool.easydeploy"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform { intellijIdeaCommunity("2024.1.5") }
}

kotlin { jvmToolchain(17) }

intellijPlatform {
    pluginConfiguration {
        id = "com.unionschool.easydeploy"
        name = "Easy Deploy"
        version = project.version.toString()
        ideaVersion { sinceBuild = "241" }
    }
}
