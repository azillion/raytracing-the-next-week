import "./style.css";

export async function initWebGPU(canvas: HTMLCanvasElement) {
    if (!navigator.gpu) {
        throw new Error("WebGPU not supported on this browser.");
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error("No appropriate GPUAdapter found.");
    }

    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu") as any;
    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();

    context.configure({
        device,
        format: presentationFormat,
    });

    return { device, context, presentationFormat };
}

const hittableShapesShader = `
struct Sphere {
    center: vec3<f32>,
    radius: f32,
}

struct HitRecord {
    p: vec3<f32>,
    normal: vec3<f32>,
    t: f32,
    hit: bool,
    front_face: bool,
}

struct FaceNormalRecord {
    front_face: bool,
    normal: vec3<f32>,
}

fn setFaceNormal(rec: HitRecord, r: Ray, outwardNormal: vec3<f32>) -> FaceNormalRecord {
    var newRec: FaceNormalRecord;
    let frontFaceDirections = dot(r.direction, outwardNormal);
    if (frontFaceDirections < 0.0) {
        newRec.front_face = true;
        newRec.normal = outwardNormal;
    } else {
        newRec.front_face = false;
        newRec.normal = -outwardNormal;
    }
    return newRec;
}

fn hit_sphere(sphere: Sphere, r: Ray, ray_tmin: f32, ray_tmax: f32) -> HitRecord {
    var rec: HitRecord;
    rec.hit = false;

    let oc = sphere.center - r.origin;
    let a = dot(r.direction, r.direction);
    let h = dot(r.direction, oc);
    let c = dot(oc, oc) - sphere.radius * sphere.radius;

    let discriminant = h * h - a * c;
    if (discriminant < 0.0) {
        return rec;
    }

    let sqrtd = sqrt(discriminant);

    // Find the nearest root that lies in the acceptable range.
    var root = (h - sqrtd) / a;
    if (root <= ray_tmin || ray_tmax <= root) {
        root = (h + sqrtd) / a;
        if (root <= ray_tmin || ray_tmax <= root) {
            return rec;
        }
    }

    rec.t = root;
    rec.p = rayAt(r, rec.t);
    rec.normal = (rec.p - sphere.center) / sphere.radius;
    let faceNormalRec = setFaceNormal(rec, r, rec.normal);
    rec.front_face = faceNormalRec.front_face;
    rec.normal = faceNormalRec.normal;
    rec.hit = true;

    return rec;
}
`;

function createComputeShader(device: GPUDevice, textureSize: { width: number, height: number }) {
    const module = device.createShaderModule({
        label: "Compute shader",
        code: `
            ${hittableShapesShader}
            struct Ray {
                origin: vec3<f32>,
                direction: vec3<f32>
            }

            fn createRay(uv: vec2<f32>) -> Ray {
                let aspectRatio = f32(textureDimensions(output).x) / f32(textureDimensions(output).y);
                let origin = vec3<f32>(0.0, 0.0, 0.0);
                let direction = vec3<f32>(uv.x * aspectRatio, uv.y, -1.0);
                return Ray(origin, normalize(direction));
            }

            fn lerp(a: vec3<f32>, b: vec3<f32>, t: f32) -> vec3<f32> {
                return a * (1.0 - t) + b * t;
            }

            fn rayColor(ray: Ray) -> vec3<f32> {
                let rec = hit_sphere(Sphere(vec3<f32>(0.0, 0.0, -1.0), 0.5), ray, 0.0, 10000.0);
                if (rec.t > 0.0) {
                    let N = normalize(rayAt(ray, rec.t) - vec3<f32>(0.0, 0.0, -1.0));
                    return 0.5 * vec3<f32>(N.x + 1.0, N.y + 1.0, N.z + 1.0);
                }
                let unit_direction = normalize(ray.direction);
                let a = 0.5 * (unit_direction.y + 1.0);
                return lerp(vec3<f32>(1.0, 1.0, 1.0), vec3<f32>(0.5, 0.7, 1.0), a);
            }

            fn rayAt(ray: Ray, t: f32) -> vec3<f32> {
                return ray.origin + ray.direction * t;
            }

            @group(0) @binding(0) var output: texture_storage_2d<rgba8unorm, write>;

            @compute @workgroup_size(8, 8)
            fn main(@builtin(global_invocation_id) id: vec3<u32>) {
                let dims = textureDimensions(output);
                let coords = vec2<u32>(id.xy);
                
                if (coords.x >= dims.x || coords.y >= dims.y) {
                    return;
                }

                let uv = (vec2<f32>(coords) + 0.5) / vec2<f32>(dims) * 2.0 - 1.0;
                let ray = createRay(uv);
                let pixel_color = rayColor(ray);
                
                textureStore(output, vec2<i32>(coords), vec4<f32>(pixel_color, 1.0));
            }
        `
    });

    const pipeline = device.createComputePipeline({
        label: "Compute pipeline",
        layout: "auto",
        compute: {
            module,
            entryPoint: "main"
        }
    });

    const texture = device.createTexture({
        size: textureSize,
        format: 'rgba8unorm',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });

    const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: texture.createView() }
        ]
    });

    return { pipeline, bindGroup, texture };
}

function createRenderPipeline(device: GPUDevice, format: GPUTextureFormat) {
    const module = device.createShaderModule({
        label: "Render shader",
        code: `
            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) uv: vec2<f32>,
            }

           @vertex
           fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
               var pos = array<vec2<f32>, 4>(
                   vec2<f32>(-1.0, -1.0),
                   vec2<f32>(1.0, -1.0),
                   vec2<f32>(-1.0, 1.0),
                   vec2<f32>(1.0, 1.0)
               );
               var uv = array<vec2<f32>, 4>(
                   vec2<f32>(0.0, 0.0),  // Changed from (0.0, 1.0)
                   vec2<f32>(1.0, 0.0),  // Changed from (1.0, 1.0)
                   vec2<f32>(0.0, 1.0),  // Changed from (0.0, 0.0)
                   vec2<f32>(1.0, 1.0)   // Changed from (1.0, 0.0)
               );
               var output: VertexOutput;
               output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
               output.uv = uv[vertexIndex];
               return output;
           } 

            @group(0) @binding(0) var textureSampler: sampler;
            @group(0) @binding(1) var inputTexture: texture_2d<f32>;

            @fragment
            fn fragmentMain(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
                return textureSample(inputTexture, textureSampler, uv);
            }
        `
    });

    return device.createRenderPipeline({
        layout: "auto",
        vertex: {
            module,
            entryPoint: "vertexMain"
        },
        fragment: {
            module,
            entryPoint: "fragmentMain",
            targets: [{ format }]
        },
        primitive: {
            topology: "triangle-strip",
            stripIndexFormat: "uint32"
        }
    });
}

async function main() {
    const canvas = document.getElementById("canvas") as HTMLCanvasElement;
    const { device, context, presentationFormat } = await initWebGPU(canvas);

    const width = 400;
    const aspectRation = 16.0 / 9.0;
    const height = Math.floor(width / aspectRation);
    canvas.width = Math.max(1, Math.min(width, device.limits.maxTextureDimension2D));
    canvas.height = Math.max(1, Math.min(height, device.limits.maxTextureDimension2D));
    let textureSize = { width: canvas.width, height: canvas.height };

    let computeShader = createComputeShader(device, textureSize);
    let renderPipeline = createRenderPipeline(device, presentationFormat);

    const sampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear"
    });

    let renderBindGroup: GPUBindGroup;

    function updateBindGroups() {
        renderBindGroup = device.createBindGroup({
            layout: renderPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: sampler },
                { binding: 1, resource: computeShader.texture.createView() }
            ]
        });
    }

    updateBindGroups();

    function render() {
        const commandEncoder = device.createCommandEncoder();

        // Run compute shader
        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(computeShader.pipeline);
        computePass.setBindGroup(0, computeShader.bindGroup);
        computePass.dispatchWorkgroups(Math.ceil(textureSize.width / 8), Math.ceil(textureSize.height / 8));
        computePass.end();

        // Render to canvas
        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: context.getCurrentTexture().createView(),
                loadOp: "clear",
                storeOp: "store",
                clearValue: { r: 0, g: 0, b: 0, a: 1 }
            }]
        });
        renderPass.setPipeline(renderPipeline);
        renderPass.setBindGroup(0, renderBindGroup);
        renderPass.draw(4);
        renderPass.end();

        device.queue.submit([commandEncoder.finish()]);
    }

    const observer = new ResizeObserver(entries => {
        for (const entry of entries) {
            const canvas = entry.target as HTMLCanvasElement;
            canvas.width = Math.max(1, Math.min(width, device.limits.maxTextureDimension2D));
            canvas.height = Math.max(1, Math.min(height, device.limits.maxTextureDimension2D));

            // Update context configuration
            context.configure({
                device,
                format: presentationFormat,
                size: [canvas.width, canvas.height]
            });

            // Recreate compute shader with new size
            textureSize = { width: canvas.width, height: canvas.height };
            computeShader = createComputeShader(device, textureSize);

            // Update bind groups
            updateBindGroups();

            // Re-render
            render();
        }
    });

    observer.observe(canvas);

    // Initial render
    render();
}

main().catch(e => {
    console.error(e);
    alert(e);
});
