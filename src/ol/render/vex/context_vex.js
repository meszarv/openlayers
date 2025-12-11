/**
 * @param {HTMLCanvasElement} canvas Canvas element.
 * @return {Promise<VexContext>} Vex context promise.
 */
let promise =null;
export function createVexContext(canvas) {
  console.log("createVexContext",{canvas});

  if(window.initVexGPU){
    console.log("createVexContext",{initVexGPU:window.initVexGPU});
    return window.initVexGPU(canvas,{interactive:false,workerScriptPath:'/vex/jswrapper/vex.worker.js'})
  }else{
    if(promise==null){
      console.log("createVexContext: no promiese",{canvas});
        promise = new Promise((resolve,reject)=>{
          // if(window.require && window.define && window.define.amd ){
          //   const onloadPromise = 
          //   window.require(['/vex/jswrapper/vex.js'],(mod)=>{
          //     createVexContext(canvas).then((result)=>resolve(result));
          //   });
            
          // }else{
            const script = document.createElement('script');
            script.src = '/vex/jswrapper/vex.js'
            script.async = true;

            script.onload = () =>{
              return createVexContext(canvas).then((result)=>resolve(result));
            }
            document.head.appendChild(script);
          // }
          
          
        })
    }
    console.log("createVexContext",{promise});
    return promise;
    
  }
}

export default createVexContext;
