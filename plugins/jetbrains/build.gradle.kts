plugins {
    kotlin("jvm") version "1.9.25"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "com.unionschool.easydeploy"
version = "0.2.0"

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        val localIde = providers.gradleProperty("localIdePath").orNull
        if (localIde != null) local(localIde) else intellijIdeaCommunity("2023.3.8")
    }
}

kotlin { jvmToolchain(17) }

intellijPlatform {
    pluginConfiguration {
        id = "com.unionschool.easydeploy"
        name = "Easy Deploy"
        version = project.version.toString()
        ideaVersion { sinceBuild = "233" }
    }
}
